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
  DEFAULT_SETTING,
  getAppearanceTokens,
  parseAppearanceSetting,
} from "./tokens";
import type { Appearance, AppearanceSetting, ColorMode, ColorScheme, ThemeName } from "./tokens";
import "./themes.css";
import {
  readReading,
  resetReading,
  READING_STORAGE_KEY,
  type ReadingPreferences,
} from "./reading";

interface AppearanceContextValue {
  /** The palette and the light or dark it resolves to now. */
  appearance: Appearance;
  /** Light, dark, or the device's setting. */
  mode: ColorMode;
  setMode: (mode: ColorMode) => void;
  setTheme: (theme: ThemeName) => void;
  setScheme: (scheme: ColorScheme) => void;
  toggleScheme: () => void;
  reading: ReadingPreferences;
  setReading: (reading: ReadingPreferences) => void;
  resetReading: () => void;
}

const AppearanceContext = createContext<AppearanceContextValue | null>(null);

function readStoredSetting(): AppearanceSetting {
  try {
    const raw = window.localStorage.getItem(APPEARANCE_STORAGE_KEY);
    return raw == null ? { ...DEFAULT_SETTING } : parseAppearanceSetting(JSON.parse(raw));
  } catch {
    // No storage (private mode, disabled) or an unreadable record.
    return { ...DEFAULT_SETTING };
  }
}

const DARK_QUERY = "(prefers-color-scheme: dark)";

function deviceScheme(): ColorScheme {
  try {
    return window.matchMedia?.(DARK_QUERY).matches === false ? "light" : "dark";
  } catch {
    return "dark";
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
    ["--focus", tokens.focus],
    ["--blue", tokens.blue],
    ["--purple", tokens.purple],
    ["--amber", tokens.amber],
    ["--green", tokens.green],
    ["--source", tokens.source],
    ["--selection", tokens.selection],
    ["--shadow", tokens.shadow],
    ["--dot", tokens.dot],
    ["--warn-bg", tokens.warnBg],
    ["--danger", tokens.danger],
    ["--dirty", tokens.dirty],
    ["--dirty-ring", tokens.dirtyRing],
    ["--note", tokens.note],
    ["--drawing", tokens.drawing],
    ["--diagram", tokens.diagram],
    ["--island", tokens.island],
    ["--island-ring", tokens.islandRing],
    ["--island-shadow", tokens.islandShadow],
    ["--tool-ink", tokens.toolInk],
    ["--tool-on", tokens.toolOn],
    ["--tool-on-ink", tokens.toolOnInk],
    ["--ui-font", tokens.uiFont],
    ["--heading-font", tokens.headingFont],
    ["--code-font", tokens.codeFont],
    ["--heading-weight", String(tokens.headingWeight)],
    ["--heading-tracking", tokens.headingTracking],
  ];
}

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [setting, setSetting] = useState<AppearanceSetting>(readStoredSetting);
  const [device, setDevice] = useState<ColorScheme>(deviceScheme);
  // Follow the device while the page is open, for the System mode.
  useEffect(() => {
    const query = window.matchMedia?.(DARK_QUERY);
    if (!query) return;
    const update = () => setDevice(query.matches ? "dark" : "light");
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const appearance = useMemo<Appearance>(
    () => ({ theme: setting.theme, scheme: setting.mode === "system" ? device : setting.mode }),
    [setting, device],
  );
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
    setSetting((prev) => (prev.theme === theme ? prev : { ...prev, theme }));
  }, []);

  const setMode = useCallback((mode: ColorMode) => {
    setSetting((prev) => (prev.mode === mode ? prev : { ...prev, mode }));
  }, []);

  /** An explicit light or dark, leaving System. */
  const setScheme = useCallback((scheme: ColorScheme) => setMode(scheme), [setMode]);

  const toggleScheme = useCallback(
    () => setMode(appearance.scheme === "dark" ? "light" : "dark"),
    [appearance.scheme, setMode],
  );

  useEffect(() => {
    try {
      window.localStorage.setItem(
        APPEARANCE_STORAGE_KEY,
        JSON.stringify(setting),
      );
    } catch {
      // Storage unavailable (private mode, quota, disabled): keep in-memory state.
    }
  }, [setting]);

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
      mode: setting.mode,
      setMode,
      setTheme,
      setScheme,
      toggleScheme,
      reading,
      setReading,
      resetReading: resetReadingPreferences,
    }),
    [
      appearance,
      setting.mode,
      setMode,
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
