import { describe, expect, test } from 'bun:test';
import { run } from '@mdx-js/mdx';
import * as runtime from 'react/jsx-runtime';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { projectFluidSource } from './fluidProjection';
import { prepareComponentEnvironment } from '../document/componentModules';
import { trustedReact } from '../../preview/trustedReact';

// The frame keeps the islands an edit did not change, with their state
// (src/preview/preview-entry.tsx): React matches each island it is given by
// the island's id, and the scope key says when the note's code outside its
// islands changed, which starts every island again.

const note = ({ code = 'const a = 1', esm = 'export const visits = 3', lead = 'Lead paragraph.', extra = '' } = {}) => `${esm}

${lead}

<Counter initial={1} />

\`\`\`js
${code}
\`\`\`

| a | b |
| - | - |
| one | two |
${extra}`;

/** The keys React sees on the islands of a note's compiled body, in order. */
async function islandKeys(text: string, format: 'md' | 'mdx') {
  const projection = await projectFluidSource(text, format);
  const { default: Content } = await run(projection.code, { ...runtime, trustedReact } as Parameters<typeof run>[1]);
  const FluidIsland = (props: { children?: ReactNode }) => props.children;
  const leaf = () => null;
  const body = Content({ components: { FluidIsland, Counter: leaf, SourceCode: leaf, SourceText: leaf } }) as ReactElement<{ children?: ReactNode }>;
  const children = ([] as ReactNode[]).concat(body.props.children);
  const keys = children.flatMap((child) => (isValidElement(child) && child.type === FluidIsland ? [child.key] : []));
  return { projection, keys };
}

describe('island keys', () => {
  test('each island the frame is given is keyed by its id, in Markdown and MDX', async () => {
    for (const [text, format] of [
      [note(), 'mdx'],
      ['# Title\n\nLead.\n\n```js\nconst a = 1\n```\n\n| a | b |\n| - | - |\n| one | two |\n\n![A picture](pic.png)\n', 'md'],
    ] as const) {
      const { projection, keys } = await islandKeys(text, format);
      expect(projection.islands.length).toBeGreaterThanOrEqual(3);
      expect(keys).toEqual(projection.islands.map((island) => island.id));
    }
  });

  test('equal islands say how many there are, so one more or one fewer of them starts them all again', async () => {
    const equal = (top: string, between = 'Text.') => `${top}Intro.\n\n<Counter initial={1} />\n\n${between}\n\n<Counter initial={1} />\n\n| a |\n| - |\n| b |\n`;
    const base = await islandKeys(equal(''), 'mdx');
    const counters = base.projection.islands.filter((island) => base.projection.text.slice(island.from, island.to).startsWith('<Counter'));
    expect(counters.map((island) => island.id)).toEqual([counters[0].id, counters[0].id.replace(/:0$/, ':1')]);
    // Their ids number them in order; the keys add how many there are. A
    // lone island's key is its id.
    expect(base.keys).toEqual(base.projection.islands.map((island) => counters.includes(island) ? `${island.id}/2` : island.id));
    // Typing between them keeps every key.
    expect((await islandKeys(equal('', 'Text, a little longer.'), 'mdx')).keys).toEqual(base.keys);
    // One more like them first: the first new one has the old first's id,
    // but none has an old one's key, so none keeps an old one's state.
    const more = await islandKeys(equal('<Counter initial={1} />\n\n'), 'mdx');
    expect(more.projection.islands.map((island) => island.id)).toContain(counters[0].id);
    const kept = more.keys.filter((key) => base.keys.includes(key));
    expect(kept).toEqual(base.keys.filter((key) => !key?.includes('/')));
    // And the ids, which the projection's checks use, are as before.
    expect(more.projection.islands.filter((island) => island.id.startsWith(counters[0].id.slice(0, -1))).map((island) => island.id))
      .toEqual([0, 1, 2].map((count) => counters[0].id.replace(/:0$/, `:${count}`)));
  });

  test('an edit inside one island changes only that island and the code, not the scope', async () => {
    const before = await islandKeys(note(), 'mdx');
    const after = await islandKeys(note({ code: 'const a = 1 // x' }), 'mdx');
    expect(after.projection.runtimeKey).not.toBe(before.projection.runtimeKey);
    expect(after.projection.scopeKey).toBe(before.projection.scopeKey);
    const changed = after.keys.filter((key, index) => key !== before.keys[index]);
    expect(changed).toHaveLength(1);
    expect(changed[0]).toBe(after.projection.islands.find((island) => after.projection.text.slice(island.from, island.to).includes('// x'))!.id);
  });

  test('prose edits keep both the code and the scope', async () => {
    const before = await projectFluidSource(note(), 'mdx');
    const after = await projectFluidSource(note({ lead: 'Lead paragraph, a little longer.' }), 'mdx');
    expect(after.runtimeKey).toBe(before.runtimeKey);
    expect(after.scopeKey).toBe(before.scopeKey);
  });

  test("the note's code outside its islands is its scope: ESM, frontmatter, format and workspace modules", async () => {
    const base = await projectFluidSource(note(), 'mdx');
    const esm = await projectFluidSource(note({ esm: 'export const visits = 4' }), 'mdx');
    expect(esm.scopeKey).not.toBe(base.scopeKey);
    const frontmatter = (title: string) => `---\ntitle: ${title}\n---\n\n${note()}`;
    expect((await projectFluidSource(frontmatter('One'), 'mdx')).scopeKey).not.toBe((await projectFluidSource(frontmatter('Two'), 'mdx')).scopeKey);
    const markdown = '# Title\n\nLead.\n\n```js\nconst a = 1\n```\n';
    expect((await projectFluidSource(markdown, 'md')).scopeKey).not.toBe((await projectFluidSource(markdown, 'mdx')).scopeKey);
    const environment = await prepareComponentEnvironment(note());
    const modules = await projectFluidSource(note(), 'mdx', { ...environment, key: 'other modules' });
    expect(modules.scopeKey).not.toBe(base.scopeKey);
  });

  test('link definitions and comments change the code but are not scope', async () => {
    const base = await projectFluidSource(note({ extra: '\n[ref]: https://example.com/one\n\n{/* a note to self */}\n' }), 'mdx');
    for (const extra of ['\n[ref]: https://example.com/two\n\n{/* a note to self */}\n', '\n[ref]: https://example.com/one\n\n{/* another note */}\n']) {
      const next = await projectFluidSource(note({ extra }), 'mdx');
      expect(next.runtimeKey).not.toBe(base.runtimeKey);
      expect(next.scopeKey).toBe(base.scopeKey);
    }
  });
});
