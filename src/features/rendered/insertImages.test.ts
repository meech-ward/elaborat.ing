import { expect,test } from 'bun:test';
import { insertImages } from './insertBlock';
import { projectFluidSource } from './fluidProjection';
import { parseImageReferences } from '../images/references';
import { applySourcePatches } from '../document';

for (const format of ['md','mdx'] as const) {
  test(`${format} image block insertion writes relative source in one precise edit`,async () => {
    const text = 'Before.\n\nAfter.';
    const document = {text,revision:7,format};
    const projection = await projectFluidSource(text,format);
    const boundary = projection.instrumentation.boundaries[1];
    const result = insertImages(document,7,projection.instrumentation.boundaries,boundary.id,'notes/note.'+format,[
      {path:'assets/photo (1).png',alt:'A [photo]'},
      {path:'assets/decorative.webp',alt:''},
    ]);
    expect(result.patch.from).toBe('Before.'.length);
    expect(result.patch.to).toBe(result.patch.from);
    const changed = applySourcePatches(document,7,[result.patch]);
    expect(changed.text).toContain('![A \\[photo\\]](../assets/photo%20%281%29.png)');
    expect(changed.text.startsWith('Before.')).toBe(true);
    expect(changed.text.endsWith('\n\nAfter.')).toBe(true);
    const refs = await parseImageReferences(changed.text,format,'notes/note.'+format);
    expect(refs.map(ref => [ref.path,ref.alt])).toEqual([['assets/photo (1).png','A [photo]'],['assets/decorative.webp','']]);
    await projectFluidSource(changed.text,format);
    expect(() => insertImages(document,6,projection.instrumentation.boundaries,boundary.id,'note.md',[{path:'a.png',alt:''}])).toThrow();
    expect(() => insertImages(document,7,projection.instrumentation.boundaries,'invented','note.md',[{path:'a.png',alt:''}])).toThrow();
    expect(() => insertImages(document,7,projection.instrumentation.boundaries,boundary.id,'note.md',[{path:'https://example.com/a.png',alt:''}])).toThrow();
  });
}

test('image and ordinary block insertion preserve CRLF so the source model keeps one Undo entry',async () => {
  const document = {text:'Before.\r\n\r\nAfter.\r\n',revision:1,format:'mdx' as const};
  const projection = await projectFluidSource(document.text,document.format);
  const boundary = projection.instrumentation.boundaries[1];
  const image = insertImages(document,1,projection.instrumentation.boundaries,boundary.id,'note.mdx',[{path:'image.png',alt:'Image',caption:'A **caption**.'}]);
  expect(image.patch.insert).toContain('\r\n\r\n<figure>\r\n');
  expect(image.patch.insert.replaceAll('\r\n','')).not.toContain('\n');
  const {insertBlock} = await import('./insertBlock');
  const block = insertBlock(document,1,projection.instrumentation.boundaries,{boundary:boundary.id,element:'Heading'},[]);
  expect(block.patch.insert).toBe('\r\n\r\n## \r\n\r\n');
});
