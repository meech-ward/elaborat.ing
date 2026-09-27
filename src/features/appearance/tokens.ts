import { z } from 'zod';
import { PALETTE_IDS, palettes, type PaletteColors, type PaletteId } from './palettes';

/** A theme is one of the colour palettes. */
export type ThemeName = PaletteId;
export type ColorScheme = 'light' | 'dark';

export interface Appearance {
  theme: ThemeName;
  scheme: ColorScheme;
}

export interface ThemeEntry {
  readonly id: ThemeName;
  readonly label: string;
}

export const themes: readonly ThemeEntry[] = palettes.map(({ id, label }) => ({ id, label }));

/**
 * Every colour of the chosen palette under its design name (bg, panel,
 * panelBorder, accentSoft ...), plus the two derived colours and the fonts.
 * Each becomes a CSS variable named after the key in kebab case
 * (`tokenProperty`): panelBorder is --panel-border, d2Fill2 is --d2-fill2.
 */
export interface AppearanceTokens extends PaletteColors {
  /** Keyboard focus rings: the accent, or accentSoftText where the accent is too light to see. */
  focus: string;
  /** A ring around the unsaved dot: `muted` where `dirty` alone is under 3:1 on a tab, otherwise transparent. */
  dirtyRing: string;
  uiFont: string;
  headingFont: string;
  codeFont: string;
  headingWeight: number;
  headingTracking: string;
}

export const DEFAULT_THEME: ThemeName = 'supabase-green';

/** Light or dark, or whatever the device uses. */
export type ColorMode = ColorScheme | 'system';

/** What people choose: a palette, and light, dark or the device's setting. */
export interface AppearanceSetting {
  theme: ThemeName;
  mode: ColorMode;
}

export const DEFAULT_SETTING: AppearanceSetting = { theme: DEFAULT_THEME, mode: 'system' };

/** The resolved appearance when nothing else is known. */
export const DEFAULT_APPEARANCE: Appearance = { theme: DEFAULT_THEME, scheme: 'dark' };

export const APPEARANCE_STORAGE_KEY = 'elaborating.appearance.v1';

const modeSchema = z.enum(['light', 'dark', 'system']);
const themeSchema = z.enum(PALETTE_IDS);

/**
 * Validate an unknown persisted setting. Records saved before the mode
 * existed hold `scheme`, which becomes the mode. A theme that is no longer
 * offered (such as the earlier Studio, Paper and Circuit) becomes the
 * default palette; anything unreadable falls back to the default setting.
 */
export function parseAppearanceSetting(value: unknown): AppearanceSetting {
  const record = z.object({ theme: z.unknown(), mode: z.unknown(), scheme: z.unknown() }).partial().safeParse(value);
  if (!record.success) return { ...DEFAULT_SETTING };
  const mode = modeSchema.safeParse(record.data.mode ?? record.data.scheme);
  if (!mode.success) return { ...DEFAULT_SETTING };
  const theme = themeSchema.safeParse(record.data.theme);
  return { theme: theme.success ? theme.data : DEFAULT_THEME, mode: mode.data };
}

/** The palette's own colours for an appearance, for screens that take colours in code (the code editor, the canvas). */
export const getPaletteColors = (appearance: Appearance): PaletteColors =>
  (palettes.find((palette) => palette.id === appearance.theme) ?? palettes[0])[appearance.scheme];

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** WCAG contrast ratio of two six-digit hex colours. */
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/** The accent where it shows at 3:1 on the panel and the background, otherwise accentSoftText. */
const focusColor = (colors: PaletteColors) =>
  contrast(colors.accent, colors.panel) >= 3 && contrast(colors.accent, colors.bg) >= 3 ? colors.accent : colors.accentSoftText;

/** The unsaved dot sits on a tab, which is the panel or, when active or hovered, seg. */
const dirtyRing = (colors: PaletteColors) =>
  contrast(colors.dirty, colors.panel) >= 3 && contrast(colors.dirty, colors.seg) >= 3 ? 'transparent' : colors.muted;

/** The fonts, the same in every palette. */
const FONT_TOKENS = {
  uiFont: "'Space Grotesk Variable', sans-serif",
  headingFont: "'Space Grotesk Variable', sans-serif",
  codeFont: "'JetBrains Mono Variable', monospace",
  headingWeight: 700,
  headingTracking: '-0.5px',
} as const;

/** The palette's colours under their design names, the derived focus and unsaved-dot ring colours, and the fonts. */
export function getAppearanceTokens(appearance: Appearance): AppearanceTokens {
  const colors = getPaletteColors(appearance);
  return { ...colors, focus: focusColor(colors), dirtyRing: dirtyRing(colors), ...FONT_TOKENS };
}

/** The CSS variable for a token key: panelBorder is --panel-border, d2Fill2 is --d2-fill2. */
export const tokenProperty = (key: string) => `--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
