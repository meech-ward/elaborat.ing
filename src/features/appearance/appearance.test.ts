import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { getAppearanceTokens, parseAppearanceSetting, themes } from './index';
import { buildPaletteCss, COLOR_TOKEN_KEYS } from './paletteCss';
import { palettes } from './palettes';
import { APPEARANCE_STORAGE_KEY, DEFAULT_THEME, tokenProperty } from './tokens';

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
  test('gives every palette colour under its design name', () => {
    for (const palette of palettes) {
      for (const scheme of ['light', 'dark'] as const) {
        expect(getAppearanceTokens({ theme: palette.id, scheme })).toMatchObject(palette[scheme]);
      }
    }
    expect(getAppearanceTokens({ theme: 'supabase-green', scheme: 'dark' }).accent).toBe('#3ECF8E');
    expect(getAppearanceTokens({ theme: 'supabase-green', scheme: 'light' }).panel).toBe('#FFFFFF');
  });

  test('gives the editor six-digit colours for every palette and scheme', () => {
    for (const { id } of themes) {
      for (const scheme of ['light', 'dark'] as const) {
        const tokens = getAppearanceTokens({ theme: id, scheme });
        for (const key of ['panel', 'text', 'accent'] as const) expect(tokens[key]).toMatch(/^#[\da-f]{6}$/i);
      }
    }
  });

  test('text, links and button text are readable in every palette and scheme', () => {
    for (const { id } of themes) {
      for (const scheme of ['light', 'dark'] as const) {
        const t = getAppearanceTokens({ theme: id, scheme });
        const where = `${id} ${scheme}`;
        expect([where, contrast(t.accentText, t.accent) >= 4.5]).toEqual([where, true]);
        for (const surface of [t.panel, t.bg, t.seg]) {
          for (const ink of [t.text, t.muted, t.accentSoftText]) expect([where, contrast(ink, surface) >= 4.5]).toEqual([where, true]);
        }
        // Dialogs sit on the panel over the background: their problems are danger text, their focus rings 3:1.
        for (const surface of [t.panel, t.bg]) {
          expect([where, contrast(t.danger, surface) >= 4.5]).toEqual([where, true]);
          expect([where, contrast(t.focus, surface) >= 3]).toEqual([where, true]);
        }
      }
    }
  });

  test('ok is a green in every palette and scheme, shown at 3:1 on the panel and background', () => {
    const hue = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
      const max = Math.max(r, g, b);
      const range = max - Math.min(r, g, b);
      if (range === 0) return 0;
      const sector = max === r ? ((g - b) / range + 6) % 6 : max === g ? (b - r) / range + 2 : (r - g) / range + 4;
      return sector * 60;
    };
    for (const { id } of themes) {
      for (const scheme of ['light', 'dark'] as const) {
        const t = getAppearanceTokens({ theme: id, scheme });
        const where = `${id} ${scheme}`;
        expect([where, hue(t.ok) >= 90 && hue(t.ok) <= 160]).toEqual([where, true]);
        for (const surface of [t.panel, t.bg]) expect([where, contrast(t.ok, surface) >= 3]).toEqual([where, true]);
      }
    }
  });

  test('the unsaved dot shows at 3:1 on a tab, or gets a muted ring that does', () => {
    const ringed: string[] = [];
    for (const { id } of themes) {
      for (const scheme of ['light', 'dark'] as const) {
        const t = getAppearanceTokens({ theme: id, scheme });
        const where = `${id} ${scheme}`;
        // A tab is the panel, or seg when it is active or hovered.
        const plain = [t.panel, t.seg].every((surface) => contrast(t.dirty, surface) >= 3);
        expect([where, t.dirtyRing]).toEqual([where, plain ? 'transparent' : t.muted]);
        if (plain) continue;
        ringed.push(where);
        for (const surface of [t.panel, t.seg]) expect([where, contrast(t.dirtyRing, surface) >= 3]).toEqual([where, true]);
      }
    }
    expect(ringed).toContain('lavender-ink light');
    expect(ringed).not.toContain('supabase-green light');
  });

  test('focus rings use the accent, or accentSoftText where the accent is too light', () => {
    expect(getAppearanceTokens({ theme: 'supabase-green', scheme: 'light' }).focus).toBe(palettes[0].light.accent);
    const volt = palettes.find((palette) => palette.id === 'ink-and-volt')!;
    expect(getAppearanceTokens({ theme: 'ink-and-volt', scheme: 'light' }).focus).toBe(volt.light.accentSoftText);
    expect(getAppearanceTokens({ theme: 'ink-and-volt', scheme: 'dark' }).focus).toBe(volt.dark.accent);
  });
});

describe('palettes.css', () => {
  const css = readFileSync(new URL('./palettes.css', import.meta.url), 'utf8');
  /** The declarations of the block that opens with `selector {`. */
  const declarations = (selector: string) => {
    const start = css.indexOf(`${selector} {\n`);
    expect([selector, start]).not.toEqual([selector, -1]);
    const body = css.slice(start + selector.length + 3, css.indexOf('}', start));
    return Object.fromEntries(body.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
      const [property, ...value] = line.replace(/;$/, '').split(': ');
      return [property, value.join(': ')];
    }));
  };
  const expected = (theme: (typeof palettes)[number]['id'], scheme: 'light' | 'dark') => {
    const tokens = getAppearanceTokens({ theme, scheme });
    return { ...Object.fromEntries(COLOR_TOKEN_KEYS.map((key) => [tokenProperty(key), tokens[key]])), 'color-scheme': scheme };
  };

  test('is up to date with palettes.ts (run `bun run palette-css` after changing a palette)', () => {
    expect(css).toBe(buildPaletteCss());
  });

  test('names every design token in kebab case, plus the focus and unsaved-dot ring colours', () => {
    expect(COLOR_TOKEN_KEYS.map(tokenProperty)).toEqual([
      '--bg', '--dot', '--panel', '--panel-border', '--field', '--text', '--body', '--muted', '--dim', '--faint',
      '--accent', '--accent-text', '--accent-soft', '--accent-soft-text', '--seg', '--ok', '--dirty', '--danger',
      '--warn-bg', '--warn-text', '--shadow', '--code-head', '--code-key', '--code-str', '--code-kw', '--line-hi',
      '--note', '--drawing', '--diagram', '--ink', '--ink-soft', '--accent-ink', '--d2-fill', '--d2-fill2',
      '--pastel-blue', '--pastel-yellow', '--pastel-green', '--pastel-pink', '--island', '--island-shadow',
      '--island-ring', '--tool-ink', '--tool-on', '--tool-on-ink', '--focus', '--dirty-ring',
    ]);
  });

  test('has a block for every palette in light and dark, selected by data-theme and data-scheme', () => {
    for (const { id } of palettes) {
      for (const scheme of ['light', 'dark'] as const) {
        expect(declarations(`:root[data-theme="${id}"][data-scheme="${scheme}"]`)).toEqual(expected(id, scheme));
      }
    }
  });

  test('the first paint is Supabase Green, dark unless the device is light', () => {
    expect(declarations(':root')).toEqual(expected('supabase-green', 'dark'));
    expect(css).toContain('@media (prefers-color-scheme: light) {\n  :root:not([data-scheme]) {');
    expect(declarations('  :root:not([data-scheme])')).toEqual(expected('supabase-green', 'light'));
  });

  test("index.html's shell reads the saved appearance under the app's key, with the app's default palette", () => {
    const html = readFileSync(new URL('../../../index.html', import.meta.url), 'utf8');
    expect(html).toContain(`localStorage.getItem("${APPEARANCE_STORAGE_KEY}")`);
    expect(html).toContain(`: "${DEFAULT_THEME}"`);
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
