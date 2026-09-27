import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { getAppearanceTokens, parseAppearanceSetting, themes } from './index';
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
    expect([tokens.danger, tokens.note, tokens.drawing, tokens.diagram]).toEqual([dark.danger, dark.note, dark.drawing, dark.diagram]);
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

  test('text, links and button text are readable in every palette and scheme', () => {
    const luminance = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => {
        const c = parseInt(hex.slice(i, i + 2), 16) / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (a: string, b: string) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    for (const { id } of themes) {
      for (const scheme of ['light', 'dark'] as const) {
        const t = getAppearanceTokens({ theme: id, scheme });
        const where = `${id} ${scheme}`;
        expect([where, contrast(t.accentText, t.accent) >= 4.5]).toEqual([where, true]);
        for (const surface of [t.bg, t.chrome, t.raised]) {
          for (const ink of [t.text, t.muted, t.link]) expect([where, contrast(ink, surface) >= 4.5]).toEqual([where, true]);
        }
        // Dialogs sit on the panel over the background: their problems are danger text, their focus rings 3:1.
        for (const surface of [t.bg, t.chrome]) {
          expect([where, contrast(t.danger, surface) >= 4.5]).toEqual([where, true]);
          expect([where, contrast(t.focus, surface) >= 3]).toEqual([where, true]);
        }
      }
    }
  });

  test('focus rings use the accent, or the link colour where the accent is too light', () => {
    expect(getAppearanceTokens({ theme: 'supabase-green', scheme: 'light' }).focus).toBe(palettes[0].light.accent);
    const volt = palettes.find((palette) => palette.id === 'ink-and-volt')!;
    expect(getAppearanceTokens({ theme: 'ink-and-volt', scheme: 'light' }).focus).toBe(volt.light.accentSoftText);
    expect(getAppearanceTokens({ theme: 'ink-and-volt', scheme: 'dark' }).focus).toBe(volt.dark.accent);
    expect(getAppearanceTokens({ theme: 'ink-and-volt', scheme: 'light' }).danger).toBe(volt.light.danger);
  });

  test('the first-paint stylesheet matches the default palette', () => {
    const css = readFileSync(new URL('./themes.css', import.meta.url), 'utf8');
    const dark = getAppearanceTokens({ theme: 'supabase-green', scheme: 'dark' });
    const light = getAppearanceTokens({ theme: 'supabase-green', scheme: 'light' });
    const [rootBlock, lightBlock] = [css.split(':root {')[1], css.split(':root[data-scheme=light] {')[1]].map((block) => block.split('}')[0]);
    for (const key of ['bg', 'chrome', 'accent', 'text', 'selection', 'danger', 'note', 'drawing', 'diagram'] as const) {
      expect(rootBlock).toContain(`--${key}:${dark[key]};`);
      expect(lightBlock).toContain(`--${key}:${light[key]};`);
    }
    expect(rootBlock).toContain(`--accent-text:${dark.accentText};`);
    expect(lightBlock).toContain(`--link:${light.link};`);
    for (const key of ['focus', 'danger'] as const) {
      expect(rootBlock).toContain(`--${key}:${dark[key]};`);
      expect(lightBlock).toContain(`--${key}:${light[key]};`);
    }
  });
});

describe('parseAppearanceSetting', () => {
  test('accepts every palette with light, dark or system', () => {
    for (const { id } of themes) {
      for (const mode of ['light', 'dark', 'system'] as const) {
        expect(parseAppearanceSetting({ theme: id, mode })).toEqual({ theme: id, mode });
      }
    }
  });

  test('reads a record saved before the mode existed, moving old themes to Supabase Green', () => {
    expect(parseAppearanceSetting({ theme: 'pewter', scheme: 'light' })).toEqual({ theme: 'pewter', mode: 'light' });
    expect(parseAppearanceSetting({ theme: 'studio', scheme: 'light' })).toEqual({ theme: 'supabase-green', mode: 'light' });
    expect(parseAppearanceSetting({ theme: 'circuit', scheme: 'dark' })).toEqual({ theme: 'supabase-green', mode: 'dark' });
  });

  test('falls back to Supabase Green following the device', () => {
    const fallback = { theme: 'supabase-green', mode: 'system' } as const;
    expect(parseAppearanceSetting(null)).toEqual(fallback);
    expect(parseAppearanceSetting('studio')).toEqual(fallback);
    expect(parseAppearanceSetting({})).toEqual(fallback);
    expect(parseAppearanceSetting({ theme: 'pewter' })).toEqual(fallback);
    expect(parseAppearanceSetting({ theme: 'pewter', mode: 'sepia' })).toEqual(fallback);
  });
});
