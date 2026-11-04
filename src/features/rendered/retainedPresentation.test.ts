import {describe, expect, test} from 'bun:test';
import {canRetainPreparingPresentation,canRetainSavedBuiltinPresentation,matchesApprovedPresentation,matchesPresentationScope} from './retainedPresentation';

const before = '# Note\n\n<Counter initial={1} />\n';
const after = `${before}\nA saved paragraph.\n`;
const exposed = {path:'note.mdx',text:before,format:'mdx' as const,components:{code:[],modules:[]}};
const document = {text:after,format:'mdx' as const};
const arrival = {documentId:2,text:after,before};

describe('saved builtin presentation handoff', () => {
  test('only the exact adopted source can keep a same-path builtin tree', () => {
    expect(canRetainSavedBuiltinPresentation(exposed,document,2,'note.mdx',arrival)).toBe(true);
    expect(canRetainSavedBuiltinPresentation(exposed,document,3,'note.mdx',arrival)).toBe(false);
    expect(canRetainSavedBuiltinPresentation(exposed,{...document,text:`${after}edit`},2,'note.mdx',arrival)).toBe(false);
    expect(canRetainSavedBuiltinPresentation(exposed,document,2,'other.mdx',arrival)).toBe(false);
    expect(canRetainSavedBuiltinPresentation(exposed,document,2,'note.mdx',{...arrival,before:'another source'})).toBe(false);
    expect(canRetainSavedBuiltinPresentation(exposed,document,2,'note.mdx',undefined)).toBe(false);
  });

  test('a Markdown handoff accepts only its exact source, identity, path and format', () => {
    const before = '# Launch plan\n\nWhat ships on day one.\n';
    const after = `${before}\n## Risks\n\nThe import is slow.\n`;
    const markdown = {path:'notes/launch.md',text:before,format:'md' as const,components:{code:[],modules:[]}};
    const document = {text:after,format:'md' as const};
    const arrival = {documentId:2,text:after,before};
    expect(canRetainSavedBuiltinPresentation(markdown,document,2,'notes/launch.md',arrival)).toBe(true);
    expect(canRetainSavedBuiltinPresentation(markdown,document,3,'notes/launch.md',arrival)).toBe(false);
    expect(canRetainSavedBuiltinPresentation(markdown,{...document,text:`${after}edit`},2,'notes/launch.md',arrival)).toBe(false);
    expect(canRetainSavedBuiltinPresentation(markdown,document,2,'notes/other.md',arrival)).toBe(false);
    expect(canRetainSavedBuiltinPresentation(markdown,{...document,format:'mdx'},2,'notes/launch.md',arrival)).toBe(false);
  });

  test('custom code, modules, provisional trees and format changes cannot cross edit identities', () => {
    expect(canRetainSavedBuiltinPresentation({...exposed,components:{code:[{}],modules:[]}},document,2,'note.mdx',arrival)).toBe(false);
    expect(canRetainSavedBuiltinPresentation({...exposed,components:{code:[],modules:[{}]}},document,2,'note.mdx',arrival)).toBe(false);
    expect(canRetainSavedBuiltinPresentation({...exposed,provisional:true},document,2,'note.mdx',arrival)).toBe(false);
    expect(canRetainSavedBuiltinPresentation(exposed,{...document,format:'md'},2,'note.mdx',arrival)).toBe(false);
    expect(canRetainSavedBuiltinPresentation(null,document,2,'note.mdx',arrival)).toBe(false);
  });
});

test('module preparation retention requires exact current source and its available approved environment', () => {
  const scope = {identity:2,path:'note.mdx',format:'mdx' as const,text:before,revision:7};
  const exposed = {...scope,components:{key:'approved:1'}};
  expect(canRetainPreparingPresentation(exposed,scope,'approved:1')).toBe(true);
  expect(matchesApprovedPresentation(exposed,scope,'approved:1')).toBe(true);
  expect(canRetainPreparingPresentation(exposed,scope,undefined)).toBe(false);
  expect(canRetainPreparingPresentation(exposed,scope,'approved:2')).toBe(false);
  expect(matchesApprovedPresentation(exposed,scope,'approved:2')).toBe(false);
  expect(matchesApprovedPresentation(exposed,scope,undefined)).toBe(false);
  expect(matchesApprovedPresentation({...exposed,components:{key:''}},scope,undefined)).toBe(true);
  expect(canRetainPreparingPresentation({...exposed,provisional:true},scope,'approved:1')).toBe(false);
  for (const different of [
    {...scope,identity:3}, {...scope,path:'other.mdx'}, {...scope,text:`${before}edit`},
    {...scope,revision:8}, {...scope,format:'md' as const},
  ]) {
    expect(canRetainPreparingPresentation(exposed,different,'approved:1')).toBe(false);
    expect(matchesPresentationScope(exposed,different)).toBe(false);
  }
});
