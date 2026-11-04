import {describe, expect, test} from 'bun:test';
import {canRetainSavedBuiltinPresentation} from './retainedPresentation';

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
