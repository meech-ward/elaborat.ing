import { describe, expect, test } from 'bun:test';
import { run } from '@mdx-js/mdx';
import * as runtime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComponentType } from 'react';
import { prepareComponentEnvironment, savedComponentSource } from './componentModules';
import { projectFluidSource } from '../rendered/fluidProjection';
import { completeSource } from '../source/completions';
import { insertBlock } from '../rendered/insertBlock';
import { applySourcePatches } from './index';
import { checkPropEdit, encodePropLiteral } from '../rendered/protocol';
import { trustedReact } from '../../preview/trustedReact';
import { TRUSTED_REACT_EXPORTS } from './trustedReactImports';

const card = `export const StatusCard = ({ title, count, ready }) => <section>{title}: {count} {ready ? 'ready' : 'waiting'}</section>;

export const componentMeta = { StatusCard: { description: 'Release status', props: { title: {type: 'string', default: 'Review'}, count: {type: 'number', default: 3}, ready: {type: 'boolean', default: true} } } };
`;

describe('custom MDX module contract', () => {
  test('module loading uses saved bytes, not a shared project draft overlay', async () => {
    const importSource = 'import { StatusCard } from "workspace:card.mdx";';
    const file = {content:'export const broken = (',savedContent:card,revision:'saved'};
    const env = await prepareComponentEnvironment(importSource,async () => savedComponentSource(file));
    expect(env.catalog.some(c => c.name === 'StatusCard')).toBe(true);
    expect(savedComponentSource({content:'ordinary saved bytes',revision:'saved'})).toEqual({text:'ordinary saved bytes',revision:'saved'});
    expect(savedComponentSource({...file,savedContent:''}).text).toBe('');
    expect(() => savedComponentSource({...file,savedContent:null})).toThrow('Save the component module');
  });
  test('trusted named React imports support aliases in local and reusable components without catalog pollution', async () => {
    const stateful = `import { useState as state, createElement } from 'react';\n\nexport const Clicker = ({ initial }) => { const [count] = state(initial); return createElement('button', null, count); };`;
    const local = await prepareComponentEnvironment(stateful+'\n\n<Clicker initial={4} />');
    expect(local.modules).toHaveLength(0);
    expect(local.catalog.some(c => c.name === 'state' || c.name === 'createElement')).toBe(false);
    const projection = await projectFluidSource(local.source,'mdx',local);
    const {default: Content} = await run(projection.code,{...runtime,trustedReact} as Parameters<typeof run>[1]);
    expect(renderToStaticMarkup(runtime.jsx(Content,{components:{FluidIsland:({children}: {children?: unknown}) => children}}))).toContain('<button>4</button>');
    const shared = await prepareComponentEnvironment('import { Clicker } from "workspace:counter.mdx";',async () => ({text:stateful,revision:'one'}));
    const result = await run(shared.modules[0].code,{...runtime,trustedReact} as Parameters<typeof run>[1]);
    expect(renderToStaticMarkup(runtime.jsx(result.Clicker as ComponentType<{initial:number}>,{initial:9}))).toBe('<button>9</button>');
    expect(Object.keys(trustedReact).sort()).toEqual([...TRUSTED_REACT_EXPORTS].sort());
    expect(Object.values(trustedReact).every(value => value !== undefined)).toBe(true);
  });

  test('refuses unsupported React exports and import forms without evaluating source', async () => {
    for (const statement of ["import React from 'react';", "import * as React from 'react';", "import 'react';", "import { notAReactExport } from 'react';", "import { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE } from 'react';", "import { useState } from 'react/hooks';", "import { useState as Counter } from 'react';", "export { useState } from 'react';", "export const X = () => import('react');"]) {
      await expect(prepareComponentEnvironment(statement)).rejects.toThrow();
    }
    await expect(prepareComponentEnvironment("import { useEffect } from 'react';\n\nexport const probe = (() => { throw new Error('parent executed'); })();")).resolves.toBeDefined();
  });
  test('discovers local metadata without evaluating user code', async () => {
    const env = await prepareComponentEnvironment(`${card}\nexport const secret = (() => { throw new Error('parent evaluated'); })();\n\n<StatusCard title="Hello" count={2} ready={true} />`);
    const definition = env.catalog.find(c => c.name === 'StatusCard');
    expect(definition?.template).toBe('<StatusCard title="Review" count={3} ready={true} />');
    expect(definition?.props.map(p => p.type)).toEqual(['string', 'number', 'boolean']);
  });

  test('resolves named shared imports and aliases, and invalidates changed saved modules', async () => {
    const source = 'import { StatusCard as ReleaseCard } from "workspace:components/cards.mdx";\n\n<ReleaseCard />';
    const first = await prepareComponentEnvironment(source, async () => ({text: card, revision:'a'}));
    expect(first.catalog.find(c => c.name === 'ReleaseCard')?.template).toContain('<ReleaseCard ');
    const second = await prepareComponentEnvironment(source, async () => ({text:card.replace('waiting','pending'), revision:'b'}));
    expect(second.key).not.toBe(first.key);
    const exports = await run(first.modules[0].code, {...runtime});
    expect(renderToStaticMarkup(runtime.jsx(exports.StatusCard as ComponentType<{title:string;count:number;ready:boolean}>, {title:'Shared',count:7,ready:true}))).toContain('Shared: 7 ready');
  });

  test('rejects unsafe, unsupported and cyclic imports plus invalid metadata', async () => {
    for (const path of ['react', 'https://evil.test/a.mdx','workspace:../private.mdx','workspace:.env','workspace:drive:module.mdx']) {
      await expect(prepareComponentEnvironment(`import { X } from ${JSON.stringify(path)};`)).rejects.toThrow();
    }
    await expect(prepareComponentEnvironment('export const X = () => import("https://evil.test/x.js");')).rejects.toThrow('Dynamic imports');
    await expect(prepareComponentEnvironment('export { X } from "workspace:x.mdx";')).rejects.toThrow('Re-exports');
    await expect(prepareComponentEnvironment('export const Counter = () => <p />;')).rejects.toThrow('reserved');
    await expect(prepareComponentEnvironment(card.replace("type: 'number'", "type: 'object'"))).rejects.toThrow('metadata');
    await expect(prepareComponentEnvironment('import { X } from "workspace:a.mdx";', async () => ({text:'import { X } from "workspace:a.mdx";',revision:'a'}))).rejects.toThrow('cycle');
    await expect(prepareComponentEnvironment('import { Missing } from "workspace:a.mdx";', async () => ({text:card,revision:'a'}))).rejects.toThrow('Missing');
  });

  test('shared runtime retains lexical scope and literal edits/picker/completion share one catalog', async () => {
    const source = 'import { StatusCard as ReleaseCard } from "workspace:components/cards.mdx";\n\nUntouched *prose*.\n\n<ReleaseCard title="Shared" count={7} ready={true} />\n';
    const env = await prepareComponentEnvironment(source, async () => ({text:card,revision:'a'}));
    const projection = await projectFluidSource(source,'mdx',env);
    const workspaceModules: Record<string, Awaited<ReturnType<typeof run>>> = {};
    for (const module of env.modules) workspaceModules[module.path] = await run(module.code,{...runtime,workspaceModules} as Parameters<typeof run>[1]);
    const {default:Content} = await run(projection.code,{...runtime,workspaceModules} as Parameters<typeof run>[1]);
    const passthrough = ({children}: {children?: unknown}) => children;
    expect(renderToStaticMarkup(runtime.jsx(Content,{components:{FluidIsland:passthrough,CustomControls:passthrough}}))).toContain('Shared: 7 ready');
    const slot = projection.slots.find(s => s.element === 'ReleaseCard')!;
    expect(slot.props.map(p => p.name)).toEqual(['title','count','ready']);
    const title = slot.props[0];
    const replacement = encodePropLiteral(title.syntax,title.kind,'Edited & saved');
    expect(checkPropEdit(projection.slots,{slot:slot.index,prop:title.name,literal:replacement,from:title.from,to:title.to,expected:title.expected})).toBe(true);
    const updated = applySourcePatches({text:source,revision:3,format:'mdx'},3,[{...title,insert:replacement}]);
    expect(updated.text).toBe(source.replace('title="Shared"','title="Edited &amp; saved"'));
    expect(checkPropEdit(projection.slots,{slot:slot.index,prop:title.name,literal:replacement,from:title.from+1,to:title.to,expected:title.expected})).toBe(false);
    const suggestions = completeSource({text:'<Rel',offset:4,language:'mdx',componentCatalog:env.catalog});
    expect(suggestions.map(c => c.label)).toEqual(['ReleaseCard']);
    const paired = completeSource({text:'<Rel>',offset:4,language:'mdx',componentCatalog:env.catalog});
    expect(paired[0].to).toBe(5);
    const insertion = insertBlock({text:source,revision:3,format:'mdx'},3,projection.instrumentation.boundaries,{element:'ReleaseCard',boundary:projection.instrumentation.boundaries[0].id},[],env.catalog);
    expect(insertion.patch.insert).toContain('<ReleaseCard title="Review" count={3} ready={true} />');
    expect(() => insertBlock({text:source,revision:3,format:'mdx'},3,projection.instrumentation.boundaries,{element:'Invented',boundary:projection.instrumentation.boundaries[0].id},[],env.catalog)).toThrow('Unknown component');
    const computed = await projectFluidSource(source.replace('count={7}','count={3+4}'),'mdx',env);
    expect(computed.slots.find(s => s.element === 'ReleaseCard')?.supported).toBe(false);
  });

  test('bounds UTF-8 source bytes and dependency depth before exposing a partial environment', async () => {
    await expect(prepareComponentEnvironment('界'.repeat(700000))).rejects.toThrow('2 MiB');
    const root = 'import { X } from "workspace:module0.mdx";';
    const loader = (last: number) => async (path: string) => {
      const index = Number(/module(\d+)/.exec(path)?.[1]);
      return {text:index === last ? 'export const X = () => <p>Leaf</p>;' : `import { X as Child } from "workspace:module${index+1}.mdx";\n\nexport const X = () => <Child />;`,revision:String(index)};
    };
    expect((await prepareComponentEnvironment(root,loader(7))).modules).toHaveLength(8);
    await expect(prepareComponentEnvironment(root,loader(8))).rejects.toThrow('depth');
  });

  test('preserves raw special-character module identities through the loader', async () => {
    const path = 'project space/100% ready#review?.mdx';
    const requested: string[] = [];
    const env = await prepareComponentEnvironment(`import { StatusCard } from ${JSON.stringify('workspace:'+path)};`, async actual => {
      requested.push(actual);
      return {text:card,revision:'special'};
    });
    expect(requested).toEqual([path]);
    expect(env.modules[0].path).toBe(path);
    expect(env.catalog.some(c => c.name === 'StatusCard')).toBe(true);
  });
});
