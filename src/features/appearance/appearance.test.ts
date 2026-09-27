import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { getAppearanceTokens, parseAppearance, themes } from './index';
import { palettes } from './palettes';

describe('themes', () => {
  test('lists the eight palettes, Supabase Green first', () => {
    expect(themes.map((entry) => entry.label)).toEqual([
      'Supabase Green',
      'Lavender Ink',
      'Blueprint Cobalt',
      'Glacier Cyan',
      'Raspberry Paper',
      'Cherry Paper',
      'Pewter',
      'Ink and Volt',
    ]);
  });
});

describe('getAppearanceTokens', () => {
  test('maps a palette onto the variables the screens use', () => {
    const dark = palettes[0].dark;
    const tokens = getAppearanceTokens({ theme: 'supabase-green', scheme: 'dark' });
    expect(tokens.bg).toBe(dark.panel);
    expect(tokens.chrome).toBe(dark.bg);
    expect(tokens.accent).toBe('#3ECF8E');
    expect(tokens.selection).toBe(dark.accentSoft);
    expect(getAppearanceTokens({ theme: 'supabase-green', scheme: 'light' }).accent).toBe('#097C4F');
    expect(getAppearanceTokens({ theme: 'pewter', scheme: 'light' }).accent).toBe(palettes[6].light.accent);
  });

  test('gives the editor six-digit colours for every palette and scheme', () => {
    for (const { id } of themes) {
      for (const scheme of ['light', 'dark'] as const) {
        const tokens = getAppearanceTokens({ theme: id, scheme });
        for (const key of ['bg', 'text', 'accent'] as const) expect(tokens[key]).toMatch(/^#[\da-f]{6}$/i);
      }
    }
  });

  test('the first-paint stylesheet matches the default palette', () => {
    const css = readFileSync(new URL('./themes.css', import.meta.url), 'utf8');
    const dark = getAppearanceTokens({ theme: 'supabase-green', scheme: 'dark' });
    const light = getAppearanceTokens({ theme: 'supabase-green', scheme: 'light' });
    const [rootBlock, lightBlock] = [css.split(':root {')[1], css.split(':root[data-scheme=light] {')[1]].map((block) => block.split('}')[0]);
    for (const key of ['bg', 'chrome', 'accent', 'text', 'selection'] as const) {
      expect(rootBlock).toContain(`--${key}:${dark[key]};`);
      expect(lightBlock).toContain(`--${key}:${light[key]};`);
    }
  });
});

describe('parseAppearance', () => {
  test('accepts every palette in both schemes', () => {
    for (const { id } of themes) {
      for (const scheme of ['light', 'dark'] as const) {
        expect(parseAppearance({ theme: id, scheme })).toEqual({ theme: id, scheme });
      }
    }
  });

  test('moves a theme that is no longer offered to Supabase Green, keeping light or dark', () => {
    expect(parseAppearance({ theme: 'studio', scheme: 'light' })).toEqual({ theme: 'supabase-green', scheme: 'light' });
    expect(parseAppearance({ theme: 'circuit', scheme: 'dark' })).toEqual({ theme: 'supabase-green', scheme: 'dark' });
  });

  test('falls back to Supabase Green dark for malformed records', () => {
    const fallback = { theme: 'supabase-green', scheme: 'dark' } as const;
    expect(parseAppearance(null)).toEqual(fallback);
    expect(parseAppearance('studio')).toEqual(fallback);
    expect(parseAppearance({})).toEqual(fallback);
    expect(parseAppearance({ theme: 'pewter' })).toEqual(fallback);
    expect(parseAppearance({ theme: 'pewter', scheme: 'system' })).toEqual(fallback);
  });
});
