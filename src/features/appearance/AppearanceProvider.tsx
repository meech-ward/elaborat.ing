import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ReactNode } from "react";
import {
  APPEARANCE_STORAGE_KEY,
  DEFAULT_APPEARANCE,
  getAppearanceTokens,
  parseAppearance,
} from "./tokens";
import type { Appearance, ColorScheme, ThemeName } from "./tokens";
import "./themes.css";
import {
  readReading,
  resetReading,
  READING_STORAGE_KEY,
  type ReadingPreferences,
} from "./reading";

interface AppearanceContextValue {
  appearance: Appearance;
  setTheme: (theme: ThemeName) => void;
  setScheme: (scheme: ColorScheme) => void;
  toggleScheme: () => void;
  reading: ReadingPreferences;
  setReading: (reading: ReadingPreferences) => void;
  resetReading: () => void;
}

const AppearanceContext = createContext<AppearanceContextValue | null>(null);

function readStoredAppearance(): Appearance {
  try {
    if (
      typeof window === "undefined" ||
      typeof window.localStorage === "undefined"
    ) {
      return { ...DEFAULT_APPEARANCE };
    }
    const raw = window.localStorage.getItem(APPEARANCE_STORAGE_KEY);
    // A first visit follows the device's light or dark setting.
    if (raw == null) {
      const light = window.matchMedia?.("(prefers-color-scheme: light)").matches;
      return { ...DEFAULT_APPEARANCE, scheme: light ? "light" : "dark" };
    }
    return parseAppearance(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
}

/** Inline variables owned by the provider (mirrors the token table). */
function tokenEntries(
  appearance: Appearance,
): Array<readonly [string, string]> {
  const tokens = getAppearanceTokens(appearance);
  return [
    ["--bg", tokens.bg],
    ["--chrome", tokens.chrome],
    ["--raised", tokens.raised],
    ["--line", tokens.line],
    ["--text", tokens.text],
    ["--muted", tokens.muted],
    ["--accent", tokens.accent],
    ["--accent-text", tokens.accentText],
    ["--link", tokens.link],
    ["--blue", tokens.blue],
    ["--purple", tokens.purple],
    ["--amber", tokens.amber],
    ["--green", tokens.green],
    ["--source", tokens.source],
    ["--selection", tokens.selection],
    ["--shadow", tokens.shadow],
    ["--ui-font", tokens.uiFont],
    ["--heading-font", tokens.headingFont],
    ["--code-font", tokens.codeFont],
    ["--heading-weight", String(tokens.headingWeight)],
    ["--heading-tracking", tokens.headingTracking],
  ];
}

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [appearance, setAppearance] =
    useState<Appearance>(readStoredAppearance);
  const [reading, setReading] = useState<ReadingPreferences>(() => {
    try {
      return readReading(window.localStorage);
    } catch {
      return resetReading();
    }
  });
  const resetReadingPreferences = useCallback(
    () => setReading(resetReading()),
    [],
  );

  useEffect(() => {
    try {
      window.localStorage.setItem(READING_STORAGE_KEY, JSON.stringify(reading));
    } catch {
      /* Keep in-memory preferences when storage is unavailable. */
    }
  }, [reading]);

  const setTheme = useCallback((theme: ThemeName) => {
    setAppearance((prev) => (prev.theme === theme ? prev : { ...prev, theme }));
  }, []);

  const setScheme = useCallback((scheme: ColorScheme) => {
    setAppearance((prev) =>
      prev.scheme === scheme ? prev : { ...prev, scheme },
    );
  }, []);

  const toggleScheme = useCallback(() => {
    setAppearance((prev) => ({
      ...prev,
      scheme: prev.scheme === "dark" ? "light" : "dark",
    }));
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        APPEARANCE_STORAGE_KEY,
        JSON.stringify(appearance),
      );
    } catch {
      // Storage unavailable (private mode, quota, disabled): keep in-memory state.
    }
  }, [appearance]);

  useEffect(() => {
    const root = document.documentElement;
    const inlineVars = tokenEntries(appearance);

    const prevTheme = root.getAttribute("data-theme");
    const prevScheme = root.getAttribute("data-scheme");
    const prevDark = root.classList.contains("dark");
    const prevInline = inlineVars.map(
      ([property]) =>
        [property, root.style.getPropertyValue(property)] as const,
    );

    root.setAttribute("data-theme", appearance.theme);
    root.setAttribute("data-scheme", appearance.scheme);
    root.classList.toggle("dark", appearance.scheme === "dark");
    for (const [property, value] of inlineVars) {
      root.style.setProperty(property, value);
    }

    return () => {
      if (prevTheme == null) root.removeAttribute("data-theme");
      else root.setAttribute("data-theme", prevTheme);
      if (prevScheme == null) root.removeAttribute("data-scheme");
      else root.setAttribute("data-scheme", prevScheme);
      root.classList.toggle("dark", prevDark);
      for (const [property, prev] of prevInline) {
        if (prev === "") root.style.removeProperty(property);
        else root.style.setProperty(property, prev);
      }
    };
  }, [appearance]);

  const value = useMemo<AppearanceContextValue>(
    () => ({
      appearance,
      setTheme,
      setScheme,
      toggleScheme,
      reading,
      setReading,
      resetReading: resetReadingPreferences,
    }),
    [
      appearance,
      setTheme,
      setScheme,
      toggleScheme,
      reading,
      resetReadingPreferences,
    ],
  );

  return (
    <AppearanceContext.Provider value={value}>
      {children}
    </AppearanceContext.Provider>
  );
}

export function useAppearance(): AppearanceContextValue {
  const context = useContext(AppearanceContext);
  if (context == null) {
    throw new Error("useAppearance must be used within AppearanceProvider");
  }
  return context;
}
