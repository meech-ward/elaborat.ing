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

export interface AppearanceTokens {
  bg: string;
  chrome: string;
  raised: string;
  line: string;
  text: string;
  muted: string;
  accent: string;
  /** Text on an accent fill, such as a primary button. */
  accentText: string;
  /** Links and other accent-coloured text, readable on every surface. */
  link: string;
  blue: string;
  purple: string;
  amber: string;
  green: string;
  source: string;
  selection: string;
  shadow: string;
  /** The dots on the app's dotted background. */
  dot: string;
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

const colorsFor = (appearance: Appearance): PaletteColors =>
  (palettes.find((palette) => palette.id === appearance.theme) ?? palettes[0])[appearance.scheme];

/**
 * The palette's colours in the variables today's screens use: the document
 * sits on the palette's panel, bars and the sidebar on its background, menus
 * on its raised fill. The four named colours are the code and callout ones.
 */
export function getAppearanceTokens(appearance: Appearance): AppearanceTokens {
  const colors = colorsFor(appearance);
  return {
    bg: colors.panel,
    chrome: colors.bg,
    raised: colors.seg,
    line: colors.panelBorder,
    text: colors.text,
    muted: colors.muted,
    accent: colors.accent,
    accentText: colors.accentText,
    link: colors.accentSoftText,
    blue: colors.codeKey,
    purple: colors.codeHead,
    amber: colors.warnText,
    green: colors.codeStr,
    source: colors.codeHead,
    selection: colors.accentSoft,
    shadow: colors.shadow,
    dot: colors.dot,
    uiFont: "'Space Grotesk Variable', sans-serif",
    headingFont: "'Space Grotesk Variable', sans-serif",
    codeFont: "'JetBrains Mono Variable', monospace",
    headingWeight: 700,
    headingTracking: '-0.5px',
  };
}
