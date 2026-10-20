import {expect,test} from 'bun:test';
import {renderToStaticMarkup} from 'react-dom/server';
import * as jsxRuntime from 'react/jsx-runtime';
import {run} from '@mdx-js/mdx';
import {CardImage} from '../cardImages';
import {parseShowResult,parseImagePreviewResult} from '../toolResult';
import {compileNote} from '../preview/compile';

const pixels = {dataURL:'data:image/png;base64,iVBORw0KGgo=',width:1,height:1};
const result = (changes:Record<string,unknown>={},meta:Record<string,unknown>={}) => ({
  structuredContent:{project_id:'p',path:'note.mdx',kind:'note',version:1,url:'https://elaborat.ing/projects/p/note.mdx',truncated:false,embeds:[],images:[{key:'assets/a.png',path:'assets/a.png',status:'ready'}],...changes},
  _meta:{'elaborat.ing/html':'<p><span data-project-image="assets/a.png">A photo</span></p>','elaborat.ing/images':{'assets/a.png':pixels},...meta},
});
test('card image metadata is source-keyed, raster-only and bounded',() => {
  const parsed = parseShowResult(result());
  expect(parsed.ok && parsed.file.images).toEqual({'assets/a.png':pixels});
  const rejected = parseShowResult(result({}, {'elaborat.ing/images':{
    'invented.png':pixels,
    'assets/a.png':{...pixels,dataURL:'https://tracking.test/a.png'},
  }}));
  expect(rejected.ok && rejected.file.images).toEqual({});
  const tooBig = parseShowResult(result({}, {'elaborat.ing/images':{'assets/a.png':{...pixels,dataURL:'data:image/png;base64,'+'AAAA'.repeat(12_000)}}}));
  expect(tooBig.ok && tooBig.file.images).toEqual({});
  const svg = parseShowResult(result({}, {'elaborat.ing/images':{'assets/a.png':{...pixels,dataURL:'data:image/svg+xml;base64,PHN2Zz4='}}}));
  expect(svg.ok && svg.file.images).toEqual({});
});
test('standalone images retain their own path key and useful unavailable fallback',() => {
  const parsed = parseShowResult(result({kind:'image',path:'assets/a.png',images:[]}));
  expect(parsed.ok && [parsed.file.kind,parsed.file.images]).toEqual(['image',{'assets/a.png':pixels}]);
  const html = renderToStaticMarkup(jsxRuntime.jsx(CardImage,{pixels,alt:'A photo'}));
  expect(html).toContain('alt="A photo"');
  expect(html).toContain(pixels.dataURL);
  expect(renderToStaticMarkup(jsxRuntime.jsx(CardImage,{alt:'A missing photo'}))).toContain('A missing photo');
});
test('deferred image calls accept only the requested file and support hosts dropping meta',() => {
  expect(parseImagePreviewResult({structuredContent:{path:'assets/a.png',status:'ready',imagePreviews:{'assets/a.png':pixels}}},'assets/a.png')).toEqual(pixels);
  expect(parseImagePreviewResult({structuredContent:{path:'other.png',imagePreviews:{'assets/a.png':pixels}}},'assets/a.png')).toBeNull();
  expect(parseImagePreviewResult({structuredContent:{path:'assets/a.png'},_meta:{'elaborat.ing/images':{'assets/a.png':pixels}}},'assets/a.png')).toEqual(pixels);
});
test('card component compilation maps static image tags through trusted pixels and retains module-relative keys',async () => {
  const program = await compileNote('import { Picture } from "workspace:components/picture.mdx"\n\n<img src="assets/note.png" alt="Note" />\n\n<Picture />',{
    'components/picture.mdx':'export const Picture = () => <img src="../assets/module.png" alt="Module" />',
  });
  const keys:string[] = [];
  const projectImage = ({src,alt}:{src:string;alt:string}) => {keys.push(src);return jsxRuntime.jsx('span',{children:alt});};
  const workspaceModules:Record<string,Awaited<ReturnType<typeof run>>> = {};
  for (const module of program.modules) workspaceModules[module.path] = await run(module.code,{...jsxRuntime,workspaceModules,projectImage} as Parameters<typeof run>[1]);
  const {default:Content} = await run(program.note!,{...jsxRuntime,workspaceModules,projectImage} as Parameters<typeof run>[1]);
  renderToStaticMarkup(jsxRuntime.jsx(Content,{components:{PreviewGuard:({children}:{children:React.ReactNode}) => children}}));
  expect(keys).toEqual(['assets/note.png','workspace:components/picture.mdx#image:../assets/module.png']);
});
