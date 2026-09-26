import { z } from 'zod';

export type ThemeName = 'studio' | 'paper' | 'circuit';
export type ColorScheme = 'light' | 'dark';

export interface Appearance {
  theme: ThemeName;
  scheme: ColorScheme;
}

export interface ThemeEntry {
  readonly id: ThemeName;
  readonly label: string;
}

export const themes: readonly ThemeEntry[] = [
  { id: 'studio', label: 'Studio' },
  { id: 'paper', label: 'Paper' },
  { id: 'circuit', label: 'Circuit' },
];

export interface AppearanceTokens {
  bg: string;
  chrome: string;
  raised: string;
  line: string;
  text: string;
  muted: string;
  accent: string;
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

export const DEFAULT_APPEARANCE: Appearance = { theme: 'studio', scheme: 'dark' };

export const APPEARANCE_STORAGE_KEY = 'elaborating.appearance.v1';

const appearanceSchema = z.object({
  theme: z.enum(['studio', 'paper', 'circuit']),
  scheme: z.enum(['light', 'dark']),
});

/** Validate an unknown persisted record; fall back to Studio dark. */
export function parseAppearance(value: unknown): Appearance {
  const parsed = appearanceSchema.safeParse(value);
  if (!parsed.success) return { ...DEFAULT_APPEARANCE };
  return parsed.data;
}

type ColorTokens = Pick<
  AppearanceTokens,
  | 'bg'
  | 'chrome'
  | 'raised'
  | 'line'
  | 'text'
  | 'muted'
  | 'accent'
  | 'blue'
  | 'purple'
  | 'amber'
  | 'green'
  | 'source'
  | 'selection'
  | 'shadow'
>;

/** Scheme defaults mirror `:root` / `:root[data-scheme=light]` (Studio values). */
const SCHEME_COLORS: Record<ColorScheme, ColorTokens> = {
  dark: {
    bg: '#191c22',
    chrome: '#11141a',
    raised: '#262b34',
    line: '#353c49',
    text: '#e8edf5',
    muted: '#a5afc0',
    accent: '#91b7ff',
    blue: '#8abaf0',
    purple: '#bcaaf3',
    amber: '#dac395',
    green: '#9ecbb3',
    source: '#bdd2f0',
    selection: '#355884',
    shadow: '#0005',
  },
  light: {
    bg: '#fff',
    chrome: '#f2f4f7',
    raised: '#e8edf4',
    line: '#cbd3df',
    text: '#202936',
    muted: '#59677c',
    accent: '#215fb4',
    blue: '#336b9e',
    purple: '#7453a8',
    amber: '#886319',
    green: '#317554',
    source: '#305f93',
    selection: '#c6defe',
    shadow: '#26374f24',
  },
};

/**
 * Theme overrides mirror the `[data-theme=...]` selectors. Studio is the
 * default (no overrides). Neither Paper nor Circuit overrides `--shadow`,
 * so it inherits the scheme default.
 */
const THEME_COLOR_OVERRIDES: Record<ThemeName, Record<ColorScheme, Partial<ColorTokens>>> = {
  studio: { dark: {}, light: {} },
  paper: {
    dark: {
      bg: '#24251f',
      chrome: '#1a1c16',
      raised: '#303329',
      line: '#44493a',
      text: '#edeee2',
      muted: '#b1b8a3',
      accent: '#c4ce91',
      blue: '#9bc8b8',
      purple: '#b7bfa0',
      amber: '#d3bf8b',
      green: '#b9cd97',
      source: '#d4dcb8',
      selection: '#515d35',
    },
    light: {
      bg: '#faf7ee',
      chrome: '#eeeade',
      raised: '#e5e6d8',
      line: '#d0cebb',
      text: '#30382b',
      muted: '#626c58',
      accent: '#5b7138',
      blue: '#356e62',
      purple: '#6e7350',
      amber: '#866020',
      green: '#4d7238',
      source: '#486647',
      selection: '#d9e4b9',
    },
  },
  circuit: {
    dark: {
      bg: '#101f2a',
      chrome: '#0b1720',
      raised: '#1c303e',
      line: '#304c5d',
      text: '#e0f1f6',
      muted: '#a0bac9',
      accent: '#71dddf',
      blue: '#7fc5e4',
      purple: '#a9bbed',
      amber: '#d2c39c',
      green: '#8ed8c2',
      source: '#91d6df',
      selection: '#28566c',
    },
    light: {
      bg: '#f0f7fa',
      chrome: '#dfebf0',
      raised: '#d3e5ec',
      line: '#b2ccd7',
      text: '#173444',
      muted: '#4e6c7e',
      accent: '#096e7e',
      blue: '#286986',
      purple: '#586daa',
      amber: '#7d671f',
      green: '#24745f',
      source: '#176577',
      selection: '#b7e5ed',
    },
  },
};

const INTER_FONT = "'Inter Variable', sans-serif";
const DM_SANS_FONT = "'DM Sans Variable', sans-serif";
const PLEX_MONO_FONT = "'IBM Plex Mono', monospace";

type FontTokens = Pick<
  AppearanceTokens,
  'uiFont' | 'headingFont' | 'codeFont' | 'headingWeight' | 'headingTracking'
>;

/** Font tokens mirror the `--ui-font` / `--heading-*` declarations per theme. */
const THEME_FONTS: Record<ThemeName, FontTokens> = {
  studio: {
    uiFont: INTER_FONT,
    headingFont: INTER_FONT,
    codeFont: PLEX_MONO_FONT,
    headingWeight: 550,
    headingTracking: '-1.7px',
  },
  paper: {
    uiFont: DM_SANS_FONT,
    headingFont: DM_SANS_FONT,
    codeFont: PLEX_MONO_FONT,
    headingWeight: 500,
    headingTracking: '-1.4px',
  },
  circuit: {
    uiFont: INTER_FONT,
    headingFont: PLEX_MONO_FONT,
    codeFont: PLEX_MONO_FONT,
    headingWeight: 400,
    headingTracking: '-2px',
  },
};

/** Resolve the full token set for a theme + scheme pair. */
export function getAppearanceTokens(appearance: Appearance): AppearanceTokens {
  return {
    ...SCHEME_COLORS[appearance.scheme],
    ...THEME_COLOR_OVERRIDES[appearance.theme][appearance.scheme],
    ...THEME_FONTS[appearance.theme],
  };
}
