import { afterEach, describe, expect, test } from 'bun:test';
import { DocumentEmbedController } from './documentEmbedController';
import type { DocumentEmbedHost } from './documentEmbeds';

const controllers: DocumentEmbedController[] = [];
afterEach(() => { for (const controller of controllers.splice(0)) controller.dispose(); });
function fixture() {
  const owner = {} as Window;
  const source = '<Document src="child.mdx" />';
  const sent: Array<Record<string, unknown>> = [];
  const attaches: Parameters<DocumentEmbedHost['attach']>[0][] = [];
  const actions: unknown[] = [];
  let detached = 0;
  const host: DocumentEmbedHost = {
    attach: request => { attaches.push(request); return () => { detached++; }; },
    action: (...args) => { actions.push(args); },
  };
  const context = {session:'session-1234',revision:3,text:source,format:'mdx' as const,owner,path:'parent.mdx',ancestors:['parent.mdx'],host,frameScriptUrl:'https://sandbox.example/frame/123/frame.js'};
  let nonce = 0;
  const controller = new DocumentEmbedController({context:() => context,
    send:message => sent.push(message as Record<string, unknown>),
    nonce:() => (++nonce).toString(16).padStart(32, '0'),
    bootstrap:config => Promise.resolve(JSON.stringify(config)),
  });
  controllers.push(controller);
  const open = (id = 'first', path = 'child.mdx', from = 0) => controller.handle({kind:'document-embed-open',session:context.session,revision:context.revision,id,path,from});
  const ready = (id = 1, parent = owner) => controller.ready({data:{kind:'document-embed-ready',nonce:id.toString(16).padStart(32,'0')},source:{parent} as Window});
  return {controller,context,sent,attaches,actions,open,ready,detached:() => detached};
}

describe('document embed capabilities', () => {
  test('each mounted view gets one distinct stable landmark label even across owner controllers', async () => {
    const first = fixture(), second = fixture();
    first.open('one'); first.open('two'); second.open('one');
    await Promise.resolve();
    const configs = [...first.sent, ...second.sent].filter(message => message.kind === 'document-embed-bootstrap')
      .map(message => JSON.parse(message.srcdoc as string) as {label:string});
    expect(configs).toHaveLength(3);
    expect(new Set(configs.map(config => config.label)).size).toBe(3);
    for (const config of configs) expect(config.label).toMatch(/^Embedded document child\.mdx, view \d+$/);
    first.open('one');
    await Promise.resolve();
    expect(first.sent.filter(message => message.kind === 'document-embed-bootstrap')).toHaveLength(2);
  });
  test('a literal reference binds only its ready child and shares app-owned status and actions', async () => {
    const f = fixture();
    f.open();
    await Promise.resolve();
    expect(f.sent.at(-1)).toMatchObject({kind:'document-embed-bootstrap',id:'first',revision:3});
    f.ready();
    expect(f.attaches).toHaveLength(1);
    expect(f.attaches[0]).toMatchObject({id:'session-1234:first',path:'child.mdx',ancestors:['parent.mdx','child.mdx'],frameScriptUrl:f.context.frameScriptUrl});
    f.attaches[0].onState({dirty:true,pending:false,height:740});
    expect(f.sent.at(-1)).toMatchObject({kind:'document-embed-state',state:{dirty:true,pending:false,height:740}});
    f.controller.handle({kind:'document-embed-action',session:f.context.session,revision:3,id:'first',action:'save'},true);
    expect(f.actions).toEqual([['session-1234:first','save']]);
    f.ready();
    expect(f.attaches).toHaveLength(1);
  });
  test('unknown paths, computed references, stale requests and wrong element offsets never bootstrap', () => {
    const f = fixture();
    f.open('wrong-path','private.mdx');
    f.open('wrong-offset','child.mdx',1);
    f.context.text = '<Document src={"child.mdx"} />';
    f.open('computed');
    f.controller.handle({kind:'document-embed-open',session:f.context.session,revision:2,id:'stale',path:'child.mdx',from:0});
    expect(f.sent.filter(message => message.kind === 'document-embed-bootstrap')).toHaveLength(0);
    f.ready();
    expect(f.attaches).toHaveLength(0);
  });
  test('Open, Save and Run require activation-checked window requests and cannot be forged over the port', () => {
    const f = fixture();
    f.open(); f.ready();
    for (const action of ['open','save','run'] as const)
      f.controller.handle({kind:'document-embed-action',session:f.context.session,revision:3,id:'first',action});
    expect(f.actions).toEqual([]);
    for (const action of ['open','save','run'] as const)
      f.controller.handle({kind:'document-embed-action',session:f.context.session,revision:3,id:'first',action},true);
    expect(f.actions).toEqual([['session-1234:first','open'],['session-1234:first','save'],['session-1234:first','run']]);
  });
  test('nonce, direct parent relationship, instance identity and removed references gate a ready frame', () => {
    const f = fixture();
    f.open();
    f.ready(2);
    f.ready(1, {} as Window);
    expect(f.attaches).toHaveLength(0);
    f.context.text = '# Reference removed';
    f.ready();
    expect(f.attaches).toHaveLength(0);
  });
  test('cycles and depth limits refuse before reading a file or making a frame', () => {
    const f = fixture();
    f.context.ancestors = ['child.mdx','parent.mdx'];
    f.open();
    expect(f.sent.at(-1)).toMatchObject({state:{error:'This document would create a circular reference.'}});
    f.context.ancestors = ['one.mdx','two.mdx','three.mdx','four.mdx','parent.mdx'];
    f.open();
    expect(f.sent.at(-1)).toMatchObject({state:{error:'Documents can be nested at most 4 levels.'}});
    f.ready();
    expect(f.attaches).toHaveLength(0);
  });
  test('instances are bounded and duplicate ready messages cannot claim a second session', () => {
    const f = fixture();
    for (let i = 0; i < 17; i++) f.open(String(i));
    expect(f.sent.at(-1)).toMatchObject({id:'16',state:{error:'Open at most 16 embedded documents in one document.'}});
    f.ready(); f.ready();
    expect(f.attaches).toHaveLength(1);
    f.open('0');
    f.ready();
    expect(f.attaches).toHaveLength(1);
  });
  test('release and source removal detach sessions and stale status callbacks cannot update another shell', () => {
    const f = fixture();
    f.open(); f.ready();
    f.controller.handle({kind:'document-embed-release',session:f.context.session,revision:3,id:'first'});
    expect(f.detached()).toBe(1);
    const count = f.sent.length;
    f.attaches[0].onState({dirty:true});
    expect(f.sent).toHaveLength(count);
    f.open('next'); f.ready(2);
    expect(f.attaches).toHaveLength(2);
    f.context.text = '';
    f.controller.reconcile();
    expect(f.detached()).toBe(2);
  });
  test('with no document open, a change of the note is not read for references', () => {
    let reads = 0;
    const context = {session:'session-1234',revision:3,format:'mdx' as const,owner:{} as Window,path:'parent.mdx',ancestors:['parent.mdx'],
      get text() { reads++; return '<Document src="child.mdx" />\n\nTyping here.'; }};
    const controller = new DocumentEmbedController({context:() => context, send:() => {}, nonce:() => '0'.repeat(32), bootstrap:() => Promise.resolve('')});
    controllers.push(controller);
    controller.reconcile();
    controller.reconcile();
    expect(reads).toBe(0);
  });
  test('with a document open, typing that keeps the references key reads nothing, and a new key reads the note again', () => {
    const f = fixture();
    let text = f.context.text, reads = 0;
    Object.defineProperty(f.context, 'text', {get: () => { reads++; return text; }});
    Object.assign(f.context, {referencesKey: 'islands-1'});
    f.open(); f.ready();
    expect(f.attaches).toHaveLength(1);
    f.controller.reconcile();
    const read = reads;
    // Prose typed after it: the same islands, so the same key.
    text = `${text}\n\nTyping here.`;
    f.controller.reconcile();
    f.controller.reconcile();
    expect(reads).toBe(read);
    expect(f.detached()).toBe(0);
    // The reference goes, and the islands' key with it: the note is read, and the view released.
    text = 'Typing here.';
    Object.assign(f.context, {referencesKey: 'islands-2'});
    f.controller.reconcile();
    expect(reads).toBeGreaterThan(read);
    expect(f.detached()).toBe(1);
  });
  test('a new view of an embedded document starts at the height it last reported', () => {
    const first = fixture();
    first.context.text = '<Document src="tall.mdx" />';
    first.open('one', 'tall.mdx');
    first.ready();
    first.attaches[0].onState({pending:false,height:612});
    // Another note (another controller) showing the same document, and one never shown here.
    const second = fixture();
    second.context.text = '<Document src="tall.mdx" />\n\n<Document src="never-shown.mdx" />';
    second.open('two', 'tall.mdx');
    second.open('three', 'never-shown.mdx', 29);
    const states = second.sent.filter(message => message.kind === 'document-embed-state');
    expect(states[0]).toMatchObject({id:'two',state:{pending:true,error:null,height:612}});
    expect(states[1]).toMatchObject({id:'three',state:{pending:true,error:null}});
    expect((states[1].state as Record<string, unknown>).height).toBeUndefined();
  });
  test('prose moving a reference keeps the mounted child and removing it cancels queued bootstrap', async () => {
    const f = fixture();
    f.open(); f.ready();
    f.context.text = `Intro\n\n${f.context.text}`;
    f.controller.reconcile();
    expect(f.detached()).toBe(0);
    f.open('second','child.mdx',7);
    f.context.text = '';
    f.controller.reconcile();
    await Promise.resolve();
    expect(f.sent.filter(message => message.kind === 'document-embed-bootstrap')).toHaveLength(0);
  });
});


test('an inactive owner never opens new documents and collapse messages retain the existing child session', () => {
  const f = fixture();
  Object.assign(f.context,{active:false});
  f.open();
  expect(f.attaches).toHaveLength(0);
  expect(f.sent).toHaveLength(0);
  Object.assign(f.context,{active:true});
  f.open();
  f.ready();
  const visible: unknown[] = [];
  f.context.host.setVisible = (...args) => {visible.push(args);};
  f.controller.handle({kind:'document-embed-visibility',session:f.context.session,revision:3,id:'first',visible:false});
  expect(visible).toEqual([['session-1234:first',false]]);
  expect(f.detached()).toBe(0);
  f.controller.handle({kind:'document-embed-visibility',session:f.context.session,revision:2,id:'first',visible:true});
  expect(visible).toHaveLength(1);
  f.controller.handle({kind:'document-embed-visibility',session:f.context.session,revision:3,id:'first',visible:true});
  expect(f.attaches).toHaveLength(1);
  expect(f.detached()).toBe(0);
});
