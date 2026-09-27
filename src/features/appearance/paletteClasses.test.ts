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

  test('the check sees a fixed colour class', () => {
    expect('rounded-lg bg-amber-50 dark:text-neutral-400'.match(fixedColour)).toEqual(['amber-50', 'neutral-400']);
    expect('bg-(--raised) text-muted-foreground'.match(fixedColour)).toBeNull();
  });
});
