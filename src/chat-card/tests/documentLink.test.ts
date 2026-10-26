import { expect, test } from 'bun:test';
import { documentLink } from '../preview/documentLink';
import { DocumentBox } from '../preview/catalog';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

test('Document fallback links to the same project root with exact encoded identities', () => {
  expect(documentLink('https://elaborat.ing/projects/p/notes/parent.mdx?view=1#heading', 'notes/details #?%.mdx'))
    .toBe('https://elaborat.ing/projects/p/notes/details%20%23%3F%25.mdx');
  for (const path of ['../secret.md','https://example.test/a.md','/a.md','notes/a.excalidraw.md'])
    expect(documentLink('https://elaborat.ing/projects/p/a.mdx', path)).toBeNull();
  expect(documentLink(null,'a.md')).toBeNull();
  expect(documentLink('https://elaborat.ing/','a.md')).toBeNull();
});

test('Document fallback names the reference and presents an escaped open link without reading it', () => {
  const html = renderToStaticMarkup(createElement(DocumentBox, {src:'notes/details.md',title:'A <detail>',url:'https://elaborat.ing/projects/p/notes/details.md'}));
  expect(html).toContain('notes/details.md');
  expect(html).toContain('A &lt;detail&gt;');
  expect(html).toContain('Open document');
  expect(html).toContain('Expand and edit this document in elaborat.ing.');
});
