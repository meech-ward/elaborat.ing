import { expect, test } from 'bun:test';
import { parseDocumentReferences } from './documentReferences';
import { isDocumentPath } from './documentPaths';

test('Document references retain literal identities, options and whole element offsets', () => {
  const tag = `<Document\n title="Notes &amp; details" defaultCollapsed={true} src='notes/it&#39;s 50%25.mdx' />`;
  const source = `😀 Introduction\r\n\r\n${tag}\r\n`;
  expect(parseDocumentReferences(source)).toEqual([{
    path: "notes/it's 50%25.mdx", title: 'Notes & details', defaultCollapsed: true,
    from: source.indexOf('<Document'), to: source.indexOf('<Document') + tag.length,
  }]);
  expect(parseDocumentReferences('<Document src="a.md" />')[0]?.defaultCollapsed).toBe(false);
  expect(parseDocumentReferences('<Document src="a.md" defaultCollapsed />')[0]?.defaultCollapsed).toBe(true);
  expect(parseDocumentReferences('<Document src="a.md" defaultCollapsed={false} />')[0]?.defaultCollapsed).toBe(false);
});

test('only actual literal MDX document tags grant access', () => {
  const tag = '<Document src="secret.mdx" />';
  for (const source of [
    `\`${tag}\``, `\`\`\`mdx\n${tag}\n\`\`\``, `{/* ${tag} */}`,
    `---\nexample: '${tag}'\n---`, `{true && ${tag}}`, `export const Component = () => ${tag}`,
    '<Document src={"secret.mdx"} />', '<Document src={selected} />', '<Document {...props} />',
    '<Document src="secret.mdx" {...props} />', '<Document src="secret.mdx" src="other.md" />',
    '<Document src="secret.mdx" title={heading} />', '<Document src="secret.mdx" defaultCollapsed={chosen} />',
    '<Document src="secret.mdx" defaultCollapsed="false" />', '<Document src="secret.mdx" extra="value" />',
    '<Document src="secret.mdx"></Document>', '<Document src="secret.mdx">Ignored</Document>',
  ]) expect(parseDocumentReferences(source), source).toEqual([]);
  expect(parseDocumentReferences(tag, 'md')).toEqual([]);
  expect(() => parseDocumentReferences('<Document src="unterminated')).toThrow();
});

test('embedded document paths are canonical same-project note identities', () => {
  for (const path of ['notes/details.md','notes/details.MDX','notes/percent%2f.md','notes/with #?& space.mdx']) {
    expect(isDocumentPath(path), path).toBe(true);
    expect(parseDocumentReferences(`<Document src="${path.replaceAll('&','&amp;')}" />`)[0]?.path).toBe(path);
  }
  for (const path of ['', '/notes/a.mdx', '../a.mdx', './a.md', 'notes//a.md', 'https://example.test/a.md',
    'C:/a.md', 'notes\\a.md', 'notes/.hidden.md', 'a.excalidraw.md', 'a.d2', 'notes/a\u0080.md',
    `notes/${'x'.repeat(512)}.md`, 'notes/cafe\u0301.md']) expect(isDocumentPath(path), path).toBe(false);
});

test('leading BOM and repeated embeds keep distinct parser identities', () => {
  const tag = '<Document src="a.md" />';
  const source = `\ufeff${tag}\n\n${tag}`;
  expect(parseDocumentReferences(source).map(ref => ref.from)).toEqual([1, source.lastIndexOf('<Document')]);
});
