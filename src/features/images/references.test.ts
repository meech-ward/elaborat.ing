import { expect, test } from 'bun:test';
import { run } from '@mdx-js/mdx';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseImageReferences, imageReferencePatch } from './references';
import { imageMarkdown, relativeImagePath, resolveImagePath } from './paths';
import { projectFluidSource } from '../rendered/fluidProjection';
import { prepareComponentEnvironment } from '../document/componentModules';

for (const format of ['md','mdx'] as const) {
  test(`${format} references resolve actual images and shared definitions without examples or remote access`,async () => {
    const source = [
      '![Photo](../assets/a%20b.png)',
      '![Second][photo]',
      '',
      '[photo]: ../assets/diagram.webp "A title"',
      '',
      '`![example](../assets/no.png)`',
      '',
      '```md',
      '![example](../assets/no.png)',
      '```',
      '',
      '![remote](https://example.com/tracking.png)',
      '![escape](../../outside.png)',
      '![encoded traversal](%2fetc/passwd.png)',
      '',
      format === 'mdx' ? '<img src="../assets/literal.jpg" alt="Portrait" />' : '<img src="../assets/literal.jpg" alt="Portrait">',
      '',
      format === 'mdx' ? '<img src={"../assets/computed.png"} />' : '<!-- ![comment](../assets/comment.png) -->',
    ].join('\n');
    const references = await parseImageReferences(source,format,'notes/plan.'+format);
    expect(references.map(ref => ref.path)).toEqual(['assets/a b.png','assets/diagram.webp','assets/literal.jpg']);
    expect(references.map(ref => ref.alt)).toEqual(['Photo','Second','Portrait']);
    expect(source.slice(references[0].from,references[0].to)).toBe('![Photo](../assets/a%20b.png)');
    expect(references[1].definition).toBeDefined();
    const patch = imageReferencePatch(source,references[1],'notes/plan.'+format,{path:'assets/new.png',alt:'New'},format);
    expect(patch.expected).toBe('![Second][photo]');
    expect(patch.insert).toBe('![New](../assets/new.png)');
  });
}

test('module image literals resolve from their module with distinct keys and computed JSX is excluded',async () => {
  const source = 'export const Local = () => <img src="assets/note.png" alt="Local" />\n\n<Local />';
  const refs = await parseImageReferences(source,'mdx','note.mdx',[
    {path:'components/card.mdx',source:'export const PictureCard = () => <img src="../assets/module.png" alt="Module" />'},
    {path:'other/card.mdx',source:'export const PictureCard = () => <img {...props} src="../assets/no.png" />'},
  ]);
  expect(refs.map(ref => [ref.path,ref.key])).toEqual([
    ['assets/note.png','assets/note.png'],
    ['assets/module.png','workspace:components/card.mdx#image:../assets/module.png'],
  ]);
});

test('image URLs preserve legal filename punctuation and refuse project escape and schemes',() => {
  const path = 'assets/a #?(%25).png';
  const relative = relativeImagePath('notes/deep/note.md',path);
  expect(relative).toBe('../../assets/a%20%23%3F%28%2525%29.png');
  expect(resolveImagePath('notes/deep/note.md',relative)).toBe(path);
  for (const src of ['https://example.com/x.png','//example.com/x.png','data:image/png;base64,AA==','/a.png','../../../a.png','..%2fa.png','..\\a.png','%2Fetc/a.png','a.png?secret','a.png#hash','%00.png'])
    expect(resolveImagePath('notes/doc.md',src)).toBeNull();
});

for (const format of ['md','mdx'] as const) {
  test(`${format} inserted descriptions remain exact alt text and ordinary image syntax`,async () => {
    const alt = 'A [screen] with {braces}, *stars*, <tags> & entities';
    const source = imageMarkdown('assets/picture.png',alt,format);
    const refs = await parseImageReferences(source,format,'note.'+format);
    expect(refs).toHaveLength(1);
    expect(refs[0].alt).toBe(alt);
  });
}

test('static JSX img calls use the trusted image renderer, including module-relative sources',async () => {
  const source = 'import { PictureCard } from "workspace:components/card.mdx"\n\n<img src="assets/note.png" alt="Note" />\n\n<PictureCard />';
  const environment = await prepareComponentEnvironment(source,async () => ({text:'export const PictureCard = () => <img src="../assets/module.png" alt="Module" />',revision:'1'}));
  const projection = await projectFluidSource(source,'mdx',environment);
  const calls:string[] = [];
  const projectImage = ({src,alt}:{src:string;alt:string}) => {calls.push(src);return jsxRuntime.jsx('span',{children:alt});};
  const workspaceModules:Record<string,Awaited<ReturnType<typeof run>>> = {};
  for (const module of environment.modules) workspaceModules[module.path] = await run(module.code,{...jsxRuntime,workspaceModules,projectImage} as Parameters<typeof run>[1]);
  const {default:Content} = await run(projection.code,{...jsxRuntime,workspaceModules,projectImage} as Parameters<typeof run>[1]);
  renderToStaticMarkup(jsxRuntime.jsx(Content,{components:{FluidIsland:({children}:{children:React.ReactNode}) => children}}));
  expect(calls).toEqual(['assets/note.png','workspace:components/card.mdx#image:../assets/module.png']);
});

test('image source offsets include a leading byte order mark',async () => {
  for (const format of ['md','mdx'] as const) {
    const source = '\ufeff![A](assets/a.png)';
    const reference = (await parseImageReferences(source,format,'note.'+format))[0];
    expect(reference.from).toBe(1);
    expect(source.slice(reference.from,reference.to)).toBe('![A](assets/a.png)');
  }
});
