import { expect, test } from 'bun:test';
import { escapeHtmlAttribute, frameLabel } from './frameLabel';

test('frame landmarks have bounded human-readable labels and no markup escapes the attribute', () => {
  expect(frameLabel()).toBe('Rendered document');
  expect(frameLabel({label:'Embedded document notes/details.md, view 2'})).toBe('Embedded document notes/details.md, view 2');
  for (const label of ['', ' ', 'x'.repeat(1025)]) expect(frameLabel({label})).toBe('Embedded document');
  expect(frameLabel({label:'x'.repeat(1024)})).toHaveLength(1024);
  expect(escapeHtmlAttribute('notes/" onfocus="alert(1) & <file>\'.md')).toBe('notes/&quot; onfocus=&quot;alert(1) &amp; &lt;file&gt;&#39;.md');
});
