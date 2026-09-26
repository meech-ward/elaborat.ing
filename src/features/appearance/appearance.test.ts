import { describe, expect, test } from 'bun:test';
import { getAppearanceTokens, parseAppearance, themes } from './index';

describe('themes', () => {
  test('lists Studio, Paper and Circuit in order', () => {
    expect(themes.map((entry) => entry.id)).toEqual(['studio', 'paper', 'circuit']);
    expect(themes.map((entry) => entry.label)).toEqual(['Studio', 'Paper', 'Circuit']);
  });
});

describe('getAppearanceTokens', () => {
  test('studio dark matches the reference defaults', () => {
    expect(getAppearanceTokens({ theme: 'studio', scheme: 'dark' })).toEqual({
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
      uiFont: "'Inter Variable', sans-serif",
      headingFont: "'Inter Variable', sans-serif",
      codeFont: "'IBM Plex Mono', monospace",
      headingWeight: 550,
      headingTracking: '-1.7px',
    });
  });

  test('studio light matches the reference scheme defaults', () => {
    const tokens = getAppearanceTokens({ theme: 'studio', scheme: 'light' });
    expect(tokens.bg).toBe('#fff');
    expect(tokens.accent).toBe('#215fb4');
    expect(tokens.selection).toBe('#c6defe');
    expect(tokens.shadow).toBe('#26374f24');
    expect(tokens.uiFont).toBe("'Inter Variable', sans-serif");
    expect(tokens.headingWeight).toBe(550);
  });

  test('paper dark applies the theme override over dark defaults', () => {
    const tokens = getAppearanceTokens({ theme: 'paper', scheme: 'dark' });
    expect(tokens.bg).toBe('#24251f');
    expect(tokens.accent).toBe('#c4ce91');
    expect(tokens.selection).toBe('#515d35');
    expect(tokens.shadow).toBe('#0005');
    expect(tokens.uiFont).toBe("'DM Sans Variable', sans-serif");
    expect(tokens.headingFont).toBe("'DM Sans Variable', sans-serif");
    expect(tokens.headingWeight).toBe(500);
    expect(tokens.headingTracking).toBe('-1.4px');
  });

  test('paper light matches the reference', () => {
    const tokens = getAppearanceTokens({ theme: 'paper', scheme: 'light' });
    expect(tokens.bg).toBe('#faf7ee');
    expect(tokens.accent).toBe('#5b7138');
    expect(tokens.selection).toBe('#d9e4b9');
    expect(tokens.shadow).toBe('#26374f24');
    expect(tokens.source).toBe('#486647');
  });

  test('circuit dark applies the theme override with mono headings', () => {
    const tokens = getAppearanceTokens({ theme: 'circuit', scheme: 'dark' });
    expect(tokens.bg).toBe('#101f2a');
    expect(tokens.accent).toBe('#71dddf');
    expect(tokens.selection).toBe('#28566c');
    expect(tokens.shadow).toBe('#0005');
    expect(tokens.uiFont).toBe("'Inter Variable', sans-serif");
    expect(tokens.headingFont).toBe("'IBM Plex Mono', monospace");
    expect(tokens.headingWeight).toBe(400);
    expect(tokens.headingTracking).toBe('-2px');
  });

  test('circuit light matches the reference', () => {
    const tokens = getAppearanceTokens({ theme: 'circuit', scheme: 'light' });
    expect(tokens.bg).toBe('#f0f7fa');
    expect(tokens.accent).toBe('#096e7e');
    expect(tokens.selection).toBe('#b7e5ed');
    expect(tokens.shadow).toBe('#26374f24');
    expect(tokens.source).toBe('#176577');
  });
});

describe('parseAppearance', () => {
  test('accepts every valid theme/scheme pair', () => {
    for (const theme of ['studio', 'paper', 'circuit'] as const) {
      for (const scheme of ['light', 'dark'] as const) {
        expect(parseAppearance({ theme, scheme })).toEqual({ theme, scheme });
      }
    }
  });

  test('falls back to Studio dark for malformed records', () => {
    const fallback = { theme: 'studio', scheme: 'dark' } as const;
    expect(parseAppearance(null)).toEqual(fallback);
    expect(parseAppearance(undefined)).toEqual(fallback);
    expect(parseAppearance('studio')).toEqual(fallback);
    expect(parseAppearance({})).toEqual(fallback);
    expect(parseAppearance({ theme: 'studio' })).toEqual(fallback);
    expect(parseAppearance({ scheme: 'dark' })).toEqual(fallback);
    expect(parseAppearance({ theme: 'noir', scheme: 'dark' })).toEqual(fallback);
    expect(parseAppearance({ theme: 'studio', scheme: 'system' })).toEqual(fallback);
  });
});
