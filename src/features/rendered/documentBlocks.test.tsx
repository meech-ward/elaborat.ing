import { describe, expect, test } from 'bun:test';
import { compile, run } from '@mdx-js/mdx';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as runtime from 'react/jsx-runtime';
import * as components from './documentBlocks';

async function renderMdx(source: string) {
  const compiled = await compile(source, { outputFormat: 'function-body' });
  const { default: Content } = await run(String(compiled), runtime);
  return renderToStaticMarkup(createElement(Content, { components }));
}

describe('document composition', () => {
  test('asides retain Markdown, readable titles and their distinct semantics', async () => {
    const html = await renderMdx(`
<Note>

Keep **this** detail.

- First detail
- Second detail

</Note>

<Warning title="Before deleting">

Check the backup.

</Warning>

<Important>Keep the key.</Important>
`);
    expect(html).toContain('<strong>this</strong>');
    expect(html).toContain('<li>Second detail</li>');
    expect(html).toMatch(/<aside[^>]*data-component="Note"[^>]*aria-labelledby=/);
    expect(html).toContain('>Note</p>');
    expect(html).toContain('>Before deleting</p>');
    expect(html).toContain('data-component="Warning"');
    expect(html).toContain('>Important</p>');
  });

  test('Instruction pairs the numbered action with a real fenced implementation', async () => {
    const html = await renderMdx(`
<Instruction>
  <Instruction.Action step={2}>

Create the **entry point**.

  </Instruction.Action>
  <Instruction.Implementation>

\`\`\`ts
export const ready = true;
\`\`\`

  </Instruction.Implementation>
</Instruction>
`);
    expect(html).toContain('Step 2');
    expect(html).toContain('<strong>entry point</strong>');
    expect(html).toContain('data-component="Instruction.Action"');
    expect(html).toContain('data-component="Instruction.Implementation"');
    expect(html).toContain('<code class="language-ts">export const ready = true;');
    expect(html.indexOf('Step 2')).toBeLessThan(html.indexOf('export const ready'));
    expect(html).not.toContain('data-component="Callout"');
  });

  test('action-only instructions render their contents without an empty implementation', async () => {
    const html = await renderMdx('<Instruction><Instruction.Action>Read this first.</Instruction.Action></Instruction>');
    expect(html).toContain('Read this first.');
    expect(html).not.toContain('data-component="Instruction.Implementation"');
    expect(html).not.toContain('Step undefined');
  });

  test('SideBySide retains compound and standalone blocks and extra content', async () => {
    const html = await renderMdx(`
<SideBySide ratio="2:3">
  <SideBySide.Block><p>Explanation</p></SideBySide.Block>
  <SideBySideBlock><ExampleCard title="Result"><p>Example output</p></ExampleCard></SideBySideBlock>
  <p>Additional supporting detail</p>
</SideBySide>
`);
    expect(html).toContain('Explanation');
    expect(html).toContain('>Result</p>');
    expect(html).toContain('Example output');
    expect(html).toContain('Additional supporting detail');
  });

  test('Tabs names and links every tab to a panel with one initial keyboard entry', async () => {
    const html = await renderMdx(`
<Tabs current="Python" aria-label="Language">
  <Tab name="TypeScript"><p>TypeScript example</p></Tab>
  <Tab name="Python"><p>Python example</p></Tab>
</Tabs>
`);
    expect(html).toContain('role="tablist" aria-label="Language"');
    const tabs = [...html.matchAll(/<button[^>]*role="tab"[^>]*>/g)].map((match) => match[0]);
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toContain('aria-selected="false"');
    expect(tabs[0]).toContain('tabindex="-1"');
    expect(tabs[1]).toContain('aria-selected="true"');
    expect(tabs[1]).toContain('tabindex="0"');
    for (const tab of tabs) {
      const id = / id="([^"]+)"/.exec(tab)?.[1];
      const target = / aria-controls="([^"]+)"/.exec(tab)?.[1];
      expect(id).toBeDefined();
      expect(target).toBeDefined();
      expect(html).toContain(`role="tabpanel" id="${target}" aria-labelledby="${id}"`);
    }
    const panels = [...html.matchAll(/<div[^>]*role="tabpanel"[^>]*>/g)].map((match) => match[0]);
    expect(panels).toHaveLength(2);
    expect(panels[0]).toContain('hidden=""');
    expect(panels[1]).not.toContain('hidden=');
    expect(html).toContain('<p>Python example</p>');
  });

  test('Tabs accepts one tab, the old current marker, and an empty group', async () => {
    const html = await renderMdx('<Tabs><Tab name="Only" current>Only panel</Tab></Tabs>');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('Only panel');
    expect(await renderMdx('<Tabs />')).not.toContain('role="tablist"');
  });
});
