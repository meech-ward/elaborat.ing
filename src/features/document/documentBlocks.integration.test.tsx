import { expect, test } from 'bun:test';
import { run } from '@mdx-js/mdx';
import * as runtime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { prepareComponentEnvironment } from './componentModules';
import { projectFluidSource } from '../rendered/fluidProjection';
import { compileForPreview, instrumentMdxSource } from '../rendered/instrumentation';
import { DOCUMENT_BLOCK_CATALOG } from './documentBlockCatalog';
import { completeSource } from '../source/completions';
import * as blocks from '../rendered/documentBlocks';
import { CodeFence, EditableCodeFence } from '../rendered/codeFence';

test('document-block starter templates render through Fluid and legacy compilation', async () => {
  const source = DOCUMENT_BLOCK_CATALOG.map(c => c.template).join('\n\n');
  const env = await prepareComponentEnvironment(source);
  const fluid = await projectFluidSource(source, 'mdx', env);
  const slots = await instrumentMdxSource(source, env.catalog);
  const legacy = await compileForPreview(source, slots.components, 'mdx');
  for (const code of [fluid.code, legacy]) {
    const { default: Content } = await run(code, runtime);
    const html = renderToStaticMarkup(runtime.jsx(Content, { components: {
      ...blocks, pre: CodeFence,
      // The iframe's SourceCode adapter subscribes to client-only revision
      // state. Exercise its real visual control with an inert SSR callback.
      SourceCode: ({ value, language }: { value: string; language: string }) =>
        runtime.jsx(EditableCodeFence, { value, language, onCommit: () => {} }),
      FluidIsland: ({ children }: {children: ReactNode}) => children,
      SourceText: ({ children }: {children: ReactNode}) => children,
      SourceBlock: ({ children }: {children: ReactNode}) => children,
    } }));
    expect(html).toContain('Instruction.Action');
    expect(html).toContain('Step 1');
    expect(html).toContain('document-code');
    expect(html).toContain('role="tablist"');
  }
});

test('compound member names complete as full valid MDX tags', () => {
  const text = '<Instruction.Imp';
  const found = completeSource({ text, offset: text.length, language: 'mdx' });
  expect(found.map(c => c.label)).toEqual(['Instruction.Implementation']);
  expect(found[0].from).toBe(0);
  expect(found[0].to).toBe(text.length);
});

test.todo('all complete component-guide MDX examples pass the real component boundary (returns with the public component guide: roadmap phase 2 step 11)', () => {});

test('reserved built-in names fail clearly instead of silently replacing custom code', async () => {
  await expect(prepareComponentEnvironment('export const Badge = () => <span>custom</span>;'))
    .rejects.toThrow('Component name Badge is reserved');
});
