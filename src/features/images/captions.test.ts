import {expect,test} from 'bun:test';
import {run} from '@mdx-js/mdx';
import * as jsxRuntime from 'react/jsx-runtime';
import {renderToStaticMarkup} from 'react-dom/server';
import {captionMarkdown,imageFigureMarkdown} from './captions';
import {parseImageReferences} from './referenceParser';
import {projectFluidSource} from '../rendered/fluidProjection';
import {insertImages} from '../rendered/insertBlock';

for (const format of ['md','mdx'] as const) {
  test(`${format} image captions remain semantic figures with rich inline formatting`,async () => {
    const caption = 'A **red** pixel with a [caption](https://example.com) and {literal braces}.';
    const text = imageFigureMarkdown('assets/a.png','A red pixel',caption,format);
    const refs = await parseImageReferences(text,format,'note.'+format);
    expect(refs).toHaveLength(1);
    expect(refs[0].figure?.caption).toContain('**red**');
    expect(refs[0].figure?.caption).toContain(format === 'mdx' ? '\\{literal braces\\}' : '{literal braces}');
    const projection = await projectFluidSource(text,format);
    const {default:Content} = await run(projection.code,{...jsxRuntime,projectImage:({alt}:{alt:string}) => jsxRuntime.jsx('img',{alt})} as Parameters<typeof run>[1]);
    const html = renderToStaticMarkup(jsxRuntime.jsx(Content,{components:{SourceText:({children}:{children:React.ReactNode}) => children,img:({alt}:{alt:string}) => jsxRuntime.jsx('img',{alt}),FluidIsland:({children}:{children:React.ReactNode}) => children}}));
    expect(html).toMatch(/<figure(?:>| )/);
    expect(html).toMatch(/<figcaption(?:>| )/);
    expect(html).toContain('<strong>red</strong>');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('{literal braces}');
    const document = {text:'Before.',revision:1,format};
    const before = await projectFluidSource(document.text,format);
    const inserted = insertImages(document,1,before.instrumentation.boundaries,before.instrumentation.boundaries.at(-1)!.id,'note.'+format,[{path:'assets/a.png',alt:'A red pixel',caption}]);
    expect(inserted.patch.insert).toContain('<figure>');
    expect(inserted.patch.insert).toContain('<figcaption>');
  });
}
test('captions reject raw HTML, executable MDX, images and multiple paragraphs while literal braces remain text',() => {
  for (const caption of ['<img src="https://tracking.test/x.png" />','![another](a.png)','First\n\nSecond','# Heading'])
    expect(() => captionMarkdown(caption,'mdx')).toThrow();
  expect(captionMarkdown('{fetch("https://tracking.test")}', 'mdx')).toBe('\\{fetch("https://tracking.test")\\}');
});

test('per-reference edits retain captions and removing a captioned image removes its own figure only',async () => {
  const {imageReferencePatch} = await import('./references');
  const figure = imageFigureMarkdown('assets/a.png','A photo','An **old** caption.','mdx');
  const source = 'Before exact.\n\n'+figure+'\n\nAfter exact.';
  const reference = (await parseImageReferences(source,'mdx','note.mdx'))[0];
  const alt = imageReferencePatch(source,reference,'note.mdx',{path:'assets/b.png',alt:'New photo'},'mdx');
  const changed = source.slice(0,alt.from)+alt.insert+source.slice(alt.to);
  expect(changed).toContain('![New photo](assets/b.png)');
  expect(changed).toContain('An **old** caption.');
  const caption = imageReferencePatch(source,reference,'note.mdx',{path:'assets/a.png',alt:'A photo',caption:'A *new* caption.'},'mdx');
  expect(source.slice(0,caption.from)+caption.insert+source.slice(caption.to)).toContain('<figcaption>\n\nA *new* caption.\n\n</figcaption>');
  const removal = imageReferencePatch(source,reference,'note.mdx',null,'mdx');
  expect(source.slice(0,removal.from)+removal.insert+source.slice(removal.to)).toBe('Before exact.\n\n\n\nAfter exact.');
});
