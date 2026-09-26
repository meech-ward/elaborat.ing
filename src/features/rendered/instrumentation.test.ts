/**
 * Focused tests for source-offset instrumentation.
 *
 * Invariants under test:
 * - Every reported range round-trips: source.slice(from, to) === expected.
 * - The shell demo elements instrument as supported literal slots:
 *   <Counter initial={3} step={1} /> and Callout with tone/title.
 * - Computed output is flagged unsupported, never silently rewritten.
 * - Plain .md stays literal markdown: no components, no evaluation hooks.
 * - Invalid MDX throws a descriptive, recoverable error.
 */
import { describe, expect, test } from 'bun:test';
import { run } from '@mdx-js/mdx';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as runtime from 'react/jsx-runtime';
import { applySourcePatches, encodeProseText } from '../document/index.js';
import {
  compileForPreview,
  extractLiteralProps,
  instrumentMarkdownSource,
  instrumentMdxSource,
  encodeTextLeaf,
} from './instrumentation';
import { encodePropLiteral } from './protocol';

const DEMO = `# Hello

Some *rich* prose here.

<Counter initial={3} step={1} />

<Callout tone="info" title="A note">Some prose</Callout>
`;

describe('instrumentMdxSource', () => {
  test('finds prose leaves with exact source ranges', async () => {
    const { leaves } = await instrumentMdxSource(DEMO);
    expect(leaves.length).toBeGreaterThan(0);
    for (const leaf of leaves) {
      expect(DEMO.slice(leaf.from, leaf.to)).toBe(leaf.expected);
    }
    const texts = leaves.map((leaf) => leaf.expected);
    expect(texts).toContain('Hello');
    expect(texts).toContain('Some prose');
  });

  test('instruments the Counter demo as supported literals', async () => {
    const { components } = await instrumentMdxSource(DEMO);
    const counter = components.find((slot) => slot.element === 'Counter');
    expect(counter).toBeDefined();
    expect(counter?.supported).toBe(true);
    const initial = counter?.props.find((prop) => prop.name === 'initial');
    const step = counter?.props.find((prop) => prop.name === 'step');
    expect(initial?.kind).toBe('number');
    expect(initial?.value).toBe(3);
    expect(step?.value).toBe(1);
    for (const prop of counter?.props ?? []) {
      expect(DEMO.slice(prop.from, prop.to)).toBe(prop.expected);
    }
    // Offsets point at the literal only, not the braces or name.
    expect(DEMO.slice(initial!.from, initial!.to)).toBe('3');
    expect(DEMO.slice(step!.from, step!.to)).toBe('1');
  });

  test('instruments the Callout demo including child prose', async () => {
    const { components, leaves } = await instrumentMdxSource(DEMO);
    const callout = components.find((slot) => slot.element === 'Callout');
    expect(callout?.supported).toBe(true);
    const tone = callout?.props.find((prop) => prop.name === 'tone');
    const title = callout?.props.find((prop) => prop.name === 'title');
    expect(tone?.kind).toBe('string');
    expect(tone?.value).toBe('info');
    expect(title?.value).toBe('A note');
    expect(leaves.map((leaf) => leaf.expected)).toContain('Some prose');
  });

  test('flags computed expressions as unsupported with a reason', async () => {
    const source = `<Counter initial={count + 1} step={1} />\n`;
    const { components } = await instrumentMdxSource(source);
    expect(components).toHaveLength(1);
    expect(components[0].supported).toBe(false);
    expect(components[0].reason).toMatch(/computed/i);
    expect(components[0].props).toHaveLength(0);
  });

  test('flags spread attributes as unsupported', async () => {
    const source = `<Counter {...settings} />\n`;
    const { components } = await instrumentMdxSource(source);
    expect(components[0].supported).toBe(false);
  });

  test('flags unknown elements as unsupported', async () => {
    const source = `<Chart data={points} />\n`;
    const { components } = await instrumentMdxSource(source);
    expect(components[0].supported).toBe(false);
    expect(components[0].reason).toMatch(/Chart/);
  });

  test('throws a descriptive error for invalid MDX', async () => {
    await expect(instrumentMdxSource('<Counter initial={} />\n')).rejects.toThrow(/invalid mdx/i);
  });
});

describe('extractLiteralProps', () => {
  test('duplicate attributes cannot authorize a different literal from the rendered last value', async () => {
    const { components } = await instrumentMdxSource('<Callout title="First" title="Last">Body</Callout>');
    expect(components[0].supported).toBe(false);
    expect(components[0].props).toEqual([]);
    expect(components[0].reason).toContain('repeats attribute title');
  });
  test('rejects valueless attributes', () => {
    const source = `<Counter disabled />`;
    const result = extractLiteralProps(
      source,
      'Counter',
      [{ type: 'mdxJsxAttribute', name: 'disabled', value: null }],
      [{ from: 9, to: 17 }],
    );
    expect(result.supported).toBe(false);
  });
});

describe('instrumentMarkdownSource', () => {
  test('plain .md stays literal: leaves found, no components', async () => {
    const source = `# Title\n\nSome *rich* prose here.\n\n<Counter initial={3} />\n`;
    const { leaves, components } = await instrumentMarkdownSource(source);
    expect(components).toHaveLength(0);
    expect(leaves.length).toBeGreaterThan(0);
    for (const leaf of leaves) {
      expect(source.slice(leaf.from, leaf.to)).toBe(leaf.expected);
    }
    // The JSX-looking line parses as an inert html block: literal text that
    // is never a component slot and never an editable leaf.
    expect(leaves.map((leaf) => leaf.expected).join(' ')).not.toMatch(/Counter/);
  });

  test('fenced code has an authoritative whole-fence editing region', async () => {
    const source = '# T\n\n```js\nconst x = 1;\n```\n';
    const { leaves } = await instrumentMarkdownSource(source);
    expect(leaves.map((leaf) => leaf.expected)).not.toContain('const x = 1;');
    const code = leaves.find(leaf => leaf.code);
    expect(code?.expected).toBe('```js\nconst x = 1;\n```');
    expect(code?.code?.value).toBe('const x = 1;');
    expect(code?.code?.language).toBe('js');
  });
});

describe('literal component content', () => {
  test('an emptied paired component retains a source-backed insertion point', async () => {
    const source = '<Card><CardContent></CardContent></Card>';
    const map = await instrumentMdxSource(source);
    const leaf = map.leaves.find(entry => entry.from === entry.to)!;
    expect(leaf).toBeDefined();
    expect(source.slice(leaf.from)).toBe('</CardContent></Card>');
    const compiled = await compileForPreview(source, map.components);
    expect(compiled).toContain('SourceText');
  });
  test('static nested app children edit independently of computed layout props and generated output stays protected', async () => {
    const source = `export const Generated = () => <p>Not an editable source leaf</p>;

<Card style={{ padding: 20 }}><CardHeader><CardTitle>Card title</CardTitle></CardHeader><CardContent>Card body &amp; details</CardContent></Card>

<Alert><AlertDescription>Alert body</AlertDescription></Alert>

<Instruction><Instruction.Action step={1}>Do this</Instruction.Action><Instruction.Implementation><SideBySide><SideBySide.Block><Note>Note body</Note></SideBySide.Block></SideBySide></Instruction.Implementation></Instruction>

<Unknown><Card>Transformed children remain protected</Card></Unknown>

<Card>{'Computed expression'}</Card>`;
    const map = await instrumentMdxSource(source);
    expect(map.leaves.map(leaf => leaf.expected)).toEqual(['Card title', 'Card body &amp; details', 'Alert body', 'Do this', 'Note body']);
    expect(map.leaves.every(leaf => leaf.literal)).toBe(true);
    const compiled = await compileForPreview(source, map.components);
    expect(compiled).toContain('literal: true');
    const leaf = map.leaves[1];
    const insert = encodeTextLeaf(leaf, 'Changed <Tag /> & {expression}\nSecond line', 'mdx');
    const changed = applySourcePatches({ text: source, revision: 0, format: 'mdx' }, 0, [{ ...leaf, insert }]);
    expect(changed.text).toBe(source.replace(leaf.expected, insert));
    await expect(instrumentMdxSource(changed.text)).resolves.toBeDefined();
    expect(changed.text).toContain('\\<Tag /> &amp; \\{expression\\}');
  });

  test('compiler exposes code value and exact fence range without Markdown encoding its text', async () => {
    const source = '<Note>\n\n```tsx\nconst node = <div>{"a&b"}</div>;\n```\n\n</Note>';
    const map = await instrumentMdxSource(source);
    const leaf = map.leaves.find(entry => entry.code)!;
    const seen: Array<Record<string, unknown>> = [];
    const module = await run(await compileForPreview(source, map.components), { ...runtime });
    renderToStaticMarkup(createElement(module.default, { components: {
      Note: ({ children }: { children: ReactNode }) => createElement('aside', null, children),
      SourceCode: (props: Record<string, unknown>) => { seen.push(props); return createElement('pre', null, String(props.value)); },
    } }));
    expect(seen).toHaveLength(1);
    expect(seen[0].from).toBe(leaf.from);
    expect(seen[0].expected).toBe(leaf.expected);
    expect(seen[0].value).toBe('const node = <div>{"a&b"}</div>;');
  });
});

describe('compileForPreview', () => {
  test('emits code with SourceText markers and slot indices', async () => {
    const { components } = await instrumentMdxSource(DEMO);
    const code = await compileForPreview(DEMO, components);
    expect(code).toContain('SourceText');
    expect(code).toContain('__slot');
    // Compiled code carries no raw import/export lines from the source.
    expect(code).not.toContain('<Counter initial={3}');
  });

  test('SourceText carries the exact source slice while children stay decoded', async () => {
    const source = '# Hi &amp; bye\n';
    const { leaves, components } = await instrumentMdxSource(source);
    expect(leaves).toHaveLength(1);
    expect(source.slice(leaves[0].from, leaves[0].to)).toBe(leaves[0].expected);
    expect(leaves[0].expected).toBe('Hi &amp; bye');
    const code = await compileForPreview(source, components);
    const seen: Array<{ expected: string; children: ReactNode }> = [];
    const SourceText = (props: { expected: string; children: ReactNode }) => {
      seen.push({ expected: props.expected, children: props.children });
      return createElement('span', null, props.children);
    };
    const module = await run(code, { ...runtime });
    const markup = renderToStaticMarkup(
      createElement(module.default, { components: { SourceText } }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].expected).toBe('Hi &amp; bye');
    expect(seen[0].children).toBe('Hi & bye');
    expect(markup).toContain('<h1>');
  });

  test('no-op blur never drifts escaping; a real edit round-trips twice', async () => {
    const source = '# Hi &amp; bye\n';
    const first = await instrumentMdxSource(source);
    const leaf = first.leaves[0];
    // No-op: decoded text re-encodes to the exact slice, so the parent skips.
    expect(encodeProseText('Hi & bye', 'mdx')).toBe(leaf.expected);
    const once = applySourcePatches({ text: source, revision: 0, format: 'mdx' }, 0, [
      { from: leaf.from, to: leaf.to, insert: encodeProseText('Hi & bye!', 'mdx'), expected: leaf.expected },
    ]);
    const second = await instrumentMdxSource(once.text);
    const leaf2 = second.leaves[0];
    expect(once.text.slice(leaf2.from, leaf2.to)).toBe(leaf2.expected);
    // Editing the previously edited leaf again works from fresh offsets.
    const twice = applySourcePatches(once, 1, [
      { from: leaf2.from, to: leaf2.to, insert: encodeProseText('Hi & bye!!', 'mdx'), expected: leaf2.expected },
    ]);
    // The document module's canonical encoder escapes `!`; the leaf keeps working anyway.
    expect(twice.text).toBe('# Hi &amp; bye\\!\\!\n');
    expect(twice.revision).toBe(2);
  });
});

describe('markdown pipeline', () => {
  const source = '# Title\n\nSome {braces} & *rich* prose.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n';

  test('plain Markdown fences compile to the same literal source-backed code editor', async () => {
    const source = '```html\n<b>{literal}</b>\n```';
    const map = await instrumentMarkdownSource(source);
    const code = await compileForPreview(source, map.components, 'md');
    const module = await run(code, { ...runtime });
    const markup = renderToStaticMarkup(createElement(module.default, { components: {
      SourceCode: ({ value }: { value: string }) => createElement('pre', null, value),
    } }));
    expect(markup).toBe('<pre>&lt;b&gt;{literal}&lt;/b&gt;</pre>');
    expect(map.leaves[0].expected).toBe(source);
  });

  test('plain .md renders real structure, never evaluates braces', async () => {
    const { leaves, components } = await instrumentMarkdownSource(source);
    expect(components).toHaveLength(0);
    for (const leaf of leaves) {
      expect(source.slice(leaf.from, leaf.to)).toBe(leaf.expected);
    }
    const code = await compileForPreview(source, components, 'md');
    const module = await run(code, { ...runtime });
    const markup = renderToStaticMarkup(
      createElement(module.default, {
        components: {
          SourceText: ({ children }: { children: ReactNode }) => createElement('span', null, children),
        },
      }),
    );
    expect(markup).toContain('<h1>');
    expect(markup).toContain('<em>');
    expect(markup).toContain('rich');
    expect(markup).toContain('{braces}');
    expect(markup).toContain('<table>');
  });
});

describe('quoted and braced string props', () => {
  test('quoted title uses entities and recompiles to the exact text', async () => {
    const source = '<Callout tone="info" title="A note">x</Callout>\n';
    const { components } = await instrumentMdxSource(source);
    const title = components[0].props.find((prop) => prop.name === 'title');
    expect(title?.syntax).toBe('quoted-double');
    expect(title?.expected).toBe('"A note"');
    const next = 'A "quoted" & more';
    const insert = encodePropLiteral('quoted-double', 'string', next);
    expect(insert).toBe('"A &quot;quoted&quot; &amp; more"');
    const patched = applySourcePatches({ text: source, revision: 0, format: 'mdx' }, 0, [
      { from: title!.from, to: title!.to, insert, expected: title!.expected },
    ]);
    // Unrelated source (tone, children, tags) is byte-identical.
    expect(patched.text).toBe('<Callout tone="info" title="A &quot;quoted&quot; &amp; more">x</Callout>\n');
    const again = await instrumentMdxSource(patched.text);
    expect(again.components[0].props.find((prop) => prop.name === 'title')?.value).toBe(next);
    // The edited document compiles and renders the exact intended text.
    const seen: Array<Record<string, unknown>> = [];
    const Callout = (props: Record<string, unknown>) => {
      seen.push(props);
      return createElement('aside', null, String(props['title']));
    };
    const code = await compileForPreview(patched.text, again.components);
    const module = await run(code, { ...runtime });
    const markup = renderToStaticMarkup(
      createElement(module.default, {
        components: {
          SourceText: ({ children }: { children: ReactNode }) => createElement('span', null, children),
          Callout,
        },
      }),
    );
    expect(seen[0]['title']).toBe(next);
    expect(markup).toContain('A &quot;quoted&quot; &amp; more');
  });

  test('braced string uses JSON escaping and preserves the tag', async () => {
    const source = '<Callout title={"A note"}>x</Callout>\n';
    const { components } = await instrumentMdxSource(source);
    const title = components[0].props.find((prop) => prop.name === 'title');
    expect(title?.syntax).toBe('braced');
    const insert = encodePropLiteral('braced', 'string', 'A "quoted" & more');
    expect(insert).toBe('"A \\"quoted\\" & more"');
    const patched = applySourcePatches({ text: source, revision: 0, format: 'mdx' }, 0, [
      { from: title!.from, to: title!.to, insert, expected: title!.expected },
    ]);
    expect(patched.text).toBe('<Callout title={"A \\"quoted\\" & more"}>x</Callout>\n');
    const again = await instrumentMdxSource(patched.text);
    // Braced instrumentation keeps the raw inner literal (escapes intact);
    // the rendered runtime value is decoded by the JS engine instead.
    expect(again.components[0].props.find((prop) => prop.name === 'title')?.value).toBe(
      'A \\"quoted\\" & more',
    );
  });
});

describe('shared remark plugins', () => {
  test('frontmatter, GFM tables and strikethrough instrument cleanly', async () => {
    const source = '---\ntitle: hi\n---\n\n~~gone~~ and **bold**\n\n| a |\n|---|\n| 1 |\n';
    const { leaves } = await instrumentMdxSource(source);
    for (const leaf of leaves) {
      expect(source.slice(leaf.from, leaf.to)).toBe(leaf.expected);
    }
    expect(leaves.map((leaf) => leaf.expected)).toContain('bold');
  });
});
