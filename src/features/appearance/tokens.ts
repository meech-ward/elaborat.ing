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
  uiFont: string;
  headingFont: string;
  codeFont: string;
  headingWeight: number;
  headingTracking: string;
}

export const DEFAULT_THEME: ThemeName = 'supabase-green';

export const DEFAULT_APPEARANCE: Appearance = { theme: DEFAULT_THEME, scheme: 'dark' };

export const APPEARANCE_STORAGE_KEY = 'elaborating.appearance.v1';

const schemeSchema = z.enum(['light', 'dark']);
const themeSchema = z.enum(PALETTE_IDS);

/**
 * Validate an unknown persisted record. A theme that is no longer offered
 * (such as the earlier Studio, Paper and Circuit) becomes the default palette
 * and keeps its light or dark choice; anything else falls back entirely.
 */
export function parseAppearance(value: unknown): Appearance {
  const record = z.object({ theme: z.unknown(), scheme: schemeSchema }).safeParse(value);
  if (!record.success) return { ...DEFAULT_APPEARANCE };
  const theme = themeSchema.safeParse(record.data.theme);
  return { theme: theme.success ? theme.data : DEFAULT_THEME, scheme: record.data.scheme };
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
    uiFont: "'Inter Variable', sans-serif",
    headingFont: "'Inter Variable', sans-serif",
    codeFont: "'IBM Plex Mono', monospace",
    headingWeight: 550,
    headingTracking: '-1.7px',
  };
}
