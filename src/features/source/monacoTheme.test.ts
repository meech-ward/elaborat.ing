import { describe, expect, test } from 'bun:test';
import { palettes } from '../appearance/palettes';
import { monacoTheme } from './monacoTheme';

const COLOR_KEYS = [
  'editor.background',
  'editor.foreground',
  'editorGutter.background',
  'editorLineNumber.foreground',
  'editorLineNumber.activeForeground',
  'editor.lineHighlightBackground',
  'editor.lineHighlightBorder',
  'editor.selectionBackground',
  'editorCursor.foreground',
  'editorWidget.background',
  'editorWidget.border',
  'editorSuggestWidget.background',
  'editorSuggestWidget.border',
  'editorSuggestWidget.foreground',
  'editorSuggestWidget.selectedBackground',
  'editorSuggestWidget.selectedForeground',
  'editorSuggestWidget.selectedIconForeground',
  'editorSuggestWidget.highlightForeground',
  'editorSuggestWidget.focusHighlightForeground',
  'editorSuggestWidget.hoverBackground',
];

const bare = (color: string) => color.slice(1).toUpperCase();

describe('monacoTheme', () => {
  for (const palette of palettes) {
    for (const scheme of ['light', 'dark'] as const) {
      test(`${palette.label} ${scheme} maps the palette onto the editor`, () => {
        const colors = palette[scheme];
        const theme = monacoTheme(colors, scheme);
        expect(theme.base).toBe(scheme === 'dark' ? 'vs-dark' : 'vs');
        expect(Object.keys(theme.colors).sort()).toEqual([...COLOR_KEYS].sort());
        for (const value of Object.values(theme.colors)) expect(value).toMatch(/^#[\da-f]{6}$/i);
        for (const rule of theme.rules) expect(rule.foreground).toMatch(/^[\da-f]{6}$/i);

        expect(theme.colors['editor.background']).toBe(colors.panel);
        expect(theme.colors['editor.foreground']).toBe(colors.text);
        expect(theme.colors['editor.lineHighlightBackground']).toBe(colors.lineHi);
        expect(theme.colors['editorLineNumber.foreground']).toBe(colors.faint);
        expect(theme.colors['editorLineNumber.activeForeground']).toBe(colors.faint);
        expect(theme.colors['editor.selectionBackground']).toBe(colors.accentSoft);
        // The chosen suggestion reads as a menu's chosen row: accentSoftText on accentSoft.
        expect(theme.colors['editorSuggestWidget.selectedBackground']).toBe(colors.accentSoft);
        expect(theme.colors['editorSuggestWidget.selectedForeground']).toBe(colors.accentSoftText);
        expect([colors.accent, colors.accentSoftText]).toContain(theme.colors['editorCursor.foreground']);

        const color = (token: string) => theme.rules.find((rule) => rule.token === token)?.foreground?.toUpperCase();
        expect(color('')).toBe(bare(colors.text));
        expect(color('keyword.mdx')).toBe(bare(colors.codeHead));
        expect(color('keyword.md')).toBe(bare(colors.codeHead));
        expect(color('type')).toBe(bare(colors.codeKey));
        expect(color('string.link')).toBe(bare(colors.codeKey));
        expect(color('string')).toBe(bare(colors.codeStr));
        expect(color('variable')).toBe(bare(colors.codeStr));
        expect(color('keyword')).toBe(bare(colors.codeKw));
        expect(color('number')).toBe(bare(colors.codeKw));
        expect(color('emphasis')).toBe(bare(colors.codeKw));
        expect(color('meta.content')).toBe(bare(colors.dim));
        expect(color('operator.mdx')).toBe(bare(colors.text));
        expect(color('operator')).toBe(bare(colors.codeKw));
      });
    }
  }

  test('the cursor falls back to the readable accent where the accent is too faint', () => {
    const volt = palettes.find((palette) => palette.id === 'ink-and-volt')!;
    expect(monacoTheme(volt.light, 'light').colors['editorCursor.foreground']).toBe(volt.light.accentSoftText);
    expect(monacoTheme(volt.dark, 'dark').colors['editorCursor.foreground']).toBe(volt.dark.accent);
  });
});
