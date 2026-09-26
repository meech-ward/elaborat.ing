import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ExampleCard, Instruction, Note, SideBySide } from './documentBlocks';

describe('document column resize composition', () => {
  test('two columns expose a named vertical separator linked to the first pane', () => {
    const html = renderToStaticMarkup(<SideBySide ratio="2:3"><p>First</p><p>Second</p></SideBySide>);
    expect(html).toContain('role="separator"');
    expect(html).toContain('aria-label="Resize columns"');
    expect(html).toContain('aria-orientation="vertical"');
    expect(html).toContain('aria-valuenow="40"');
    const pane = /aria-controls="([^"]+)"/.exec(html)?.[1];
    expect(pane).toBeDefined();
    expect(html).toContain(`id="${pane}" class="document-block-body document-column"`);
    expect(html).toMatch(/contenteditable="false"/i);
  });

  test('instruction inherits the separator without losing steps or implementation', () => {
    const html = renderToStaticMarkup(<Instruction>
      <Instruction.Action step={1}><p>First action</p></Instruction.Action>
      <Instruction.Action step={2}><p>Next action</p></Instruction.Action>
      <Instruction.Implementation><pre>Result</pre></Instruction.Implementation>
    </Instruction>);
    expect(html).toContain('aria-valuenow="38"');
    for (const text of ['First action', 'Next action', 'Result', 'Step 1', 'Step 2']) expect(html).toContain(text);
  });

  test('single-column and read-only compositions have no unusable resize control', () => {
    const cases = [
      <SideBySide><p>Only</p></SideBySide>,
      <SideBySide ratio="1"><p>First</p><p>Second</p></SideBySide>,
      <SideBySide readOnly><p>First</p><p>Second</p></SideBySide>,
      <Instruction><Instruction.Action>Only action</Instruction.Action></Instruction>,
    ];
    for (const item of cases) expect(renderToStaticMarkup(item)).not.toContain('role="separator"');
  });

  test('extra rows and nested content survive; callbacks never leak into HTML', () => {
    let commits = 0;
    const html = renderToStaticMarkup(<SideBySide minWidth={30} onRatioCommit={() => { commits++; }}>
      <SideBySide.Block><Note>First</Note></SideBySide.Block>
      <SideBySide.Block><p>Second</p></SideBySide.Block>
      <p>Third</p><p>Fourth</p>
    </SideBySide>);
    for (const text of ['First', 'Second', 'Third', 'Fourth']) expect(html).toContain(text);
    expect(html.match(/role="separator"/g)).toHaveLength(1);
    expect(html).not.toContain('minWidth=');
    expect(html).not.toContain('onRatioCommit=');
    expect(commits).toBe(0);
  });

  test('literal-title adapters can supply React content without a native title attribute', () => {
    const html = renderToStaticMarkup(<><Note title={<span>Editable note title</span>}>Body</Note>
      <ExampleCard title={<span>Editable example title</span>}>Example</ExampleCard></>);
    expect(html).toContain('<span>Editable note title</span>');
    expect(html).toContain('<span>Editable example title</span>');
    expect(html).not.toContain('title="[object Object]"');
  });
});
