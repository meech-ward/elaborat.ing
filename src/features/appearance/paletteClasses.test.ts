import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

// Fixed Tailwind colours (bg-red-50, dark:text-neutral-400, var(--color-amber-300)
// and so on) ignore the chosen palette. Everything under src/ takes its colours
// from the palette's variables instead.
const fixedColour =
  /\b(?:red|amber|neutral|green|blue|gray|grey|zinc|slate|stone|emerald|sky|yellow|orange|lime|teal|cyan|indigo|violet|purple|fuchsia|pink|rose)-(?:50|[1-9]00|950)\b/g;

// Files that may still use fixed colours, each named with the reason. Empty now.
const allowed = new Set<string>([]);

const src = join(import.meta.dir, '..', '..');

// The variables the screens used before the design tokens (palettes.css), and
// the design token each became. The app's old --bg (the panel) is --panel now,
// and --bg is the design's background.
const renamed = {
  chrome: 'bg',
  raised: 'seg',
  line: 'panel-border',
  link: 'accent-soft-text',
  blue: 'code-key',
  purple: 'code-head',
  amber: 'warn-text',
  green: 'code-str',
  source: 'code-head',
  selection: 'accent-soft',
} as const;
const retired = new RegExp(`--(${Object.keys(renamed).join('|')})(?![-\\w])`, 'g');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:tsx?|css)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe('palette colours', () => {
  test('nothing under src/ uses fixed Tailwind colours', () => {
    const found: string[] = [];
    for (const path of sourceFiles(src)) {
      const name = relative(src, path);
      if (allowed.has(name)) continue;
      readFileSync(path, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          for (const match of line.matchAll(fixedColour)) found.push(`src/${name}:${index + 1} ${match[0]}`);
        });
    }
    expect(found).toEqual([]);
  });

  test('nothing under src/ uses the variable names the design tokens replaced', () => {
    const found: string[] = [];
    for (const path of sourceFiles(src)) {
      readFileSync(path, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          for (const match of line.matchAll(retired)) found.push(`src/${relative(src, path)}:${index + 1} ${match[0]} (now --${renamed[match[1] as keyof typeof renamed]})`);
        });
    }
    expect(found).toEqual([]);
  });

  test('the checks see a fixed colour class and a replaced variable', () => {
    expect('var(--raised) bg-(--line) var(--line-hi) var(--selection)'.match(retired)).toEqual(['--raised', '--line', '--selection']);
    expect('rounded-lg bg-amber-50 dark:text-neutral-400'.match(fixedColour)).toEqual(['amber-50', 'neutral-400']);
    expect('bg-(--raised) text-muted-foreground'.match(fixedColour)).toBeNull();
  });
});
