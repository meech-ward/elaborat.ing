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

  test('custom code, modules, provisional trees and format changes cannot cross edit identities', () => {
    expect(canRetainSavedBuiltinPresentation({...exposed,components:{code:[{}],modules:[]}},document,2,'note.mdx',arrival)).toBe(false);
    expect(canRetainSavedBuiltinPresentation({...exposed,components:{code:[],modules:[{}]}},document,2,'note.mdx',arrival)).toBe(false);
    expect(canRetainSavedBuiltinPresentation({...exposed,provisional:true},document,2,'note.mdx',arrival)).toBe(false);
    expect(canRetainSavedBuiltinPresentation(exposed,{...document,format:'md'},2,'note.mdx',arrival)).toBe(false);
    expect(canRetainSavedBuiltinPresentation(null,document,2,'note.mdx',arrival)).toBe(false);
  });
});
