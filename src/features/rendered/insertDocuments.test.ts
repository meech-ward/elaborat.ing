import { expect, test } from 'bun:test';
import { insertBlock } from './insertBlock';
import { applySourcePatches } from '../document';
import { parseDocumentReferences } from '../document/documentReferences';

test('Document block insertion uses one source edit and an existing literal project note', () => {
  const source = {text:'Before.\r\n\r\nAfter.\r\n',revision:3,format:'mdx' as const};
  const paths = ['notes/details & "quotes".md'];
  const result = insertBlock(source,3,[{id:'after',offset:7}],{boundary:'after',element:'Document',path:paths[0]},paths);
  const changed = applySourcePatches(source,3,[result.patch]);
  expect(result.patch.from).toBe(7);
  expect(result.patch.to).toBe(7);
  expect(result.patch.insert.replaceAll('\r\n','')).not.toContain('\n');
  expect(parseDocumentReferences(changed.text)[0]).toMatchObject({path:paths[0],title:'Details',defaultCollapsed:true});
  for (const path of ['notes/missing.md','image.png','../details.md','sketch.excalidraw.md'])
    expect(() => insertBlock(source,3,[{id:'after',offset:7}],{boundary:'after',element:'Document',path},paths)).toThrow();
  expect(() => insertBlock({...source,format:'md'},3,[{id:'after',offset:7}],{boundary:'after',element:'Document',path:paths[0]},paths)).toThrow('MDX');
});
