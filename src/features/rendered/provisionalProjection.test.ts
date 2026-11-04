import { expect, test } from 'bun:test';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { projectFluidSource, fluidPositionForSourceOffset } from './fluidProjection';

const render = (code: string) => {
  const image = ({src,alt}: {src:string;alt?:string}) => createElement('span',{'data-static-image':src},alt);
  const result = new Function(code)({jsx, jsxs, Fragment,projectImage:image});
  return renderToStaticMarkup(createElement(result.default, {components: {FluidIsland: ({children}: {children: import('react').ReactNode}) => children,img:image,ProjectImage:image}}));
};

test('provisional projection parses all MDX and maps prose but emits no ESM, expressions or JSX code', async () => {
  const source = 'import { Remote } from "workspace:slow.mdx"\n\nexport const secret = (() => { throw new Error("must never run") })();\n\n# Read immediately\n\nProse &amp; exact source.\n\n<Remote value={secret}><span>{secret}</span></Remote>\n\nInline {secret} after.\n';
  const projection = await projectFluidSource(source, 'mdx', undefined, {label: 'Loading component'});
  expect(projection.doc.textContent).toContain('Read immediately');
  expect(projection.doc.textContent).toContain('Prose & exact source.');
  expect(projection.components.modules).toEqual([]);
  expect(projection.components.code).toEqual([]);
  expect(projection.code).not.toContain('must never run');
  expect(projection.code).not.toContain('workspace:slow.mdx');
  expect(projection.code).not.toContain('secret');
  expect(render(projection.code)).toContain('Loading component');
  expect(fluidPositionForSourceOffset(projection, source.indexOf('Prose'))).not.toBeNull();
  expect(projection.text).toBe(source);
});

test('invalid complete source still fails rather than interpreting a partial document', async () => {
  await expect(projectFluidSource('# Earlier prose\n\n<Broken', 'mdx', undefined, {label:'Loading component'})).rejects.toThrow('Invalid MDX');
});

test('pending and unavailable projections keep protected island identities and prose structure', async () => {
  const source = '# Readable\n\nBefore <Custom /> and after.\n\n<Custom />\n';
  const pending = await projectFluidSource(source, 'mdx', undefined, {label:'Loading component'});
  const failed = await projectFluidSource(source, 'mdx', undefined, {label:'Component unavailable'});
  expect(failed.doc.toJSON()).toEqual(pending.doc.toJSON());
  expect(failed.islands).toEqual(pending.islands);
  expect(render(failed.code)).toContain('Component unavailable');
});


test('independent static images use the trusted image renderer while every executable image context stays deferred', async () => {
  const source = `import { Remote } from "workspace:slow.mdx"

export const secret = (() => { throw new Error("esm-must-not-run") })();

# Read immediately

![Markdown image](normal.png)

<img src="literal.png" alt="Literal image" />

<img src="handler.png" onError={() => { throw new Error("handler-must-not-run") }} />

<img src={(() => { throw new Error("src-must-not-run") })()} />

<img src="spread.png" {...{alt:(() => { throw new Error("spread-must-not-run") })()}} />

<img src="duplicate-a.png" src="duplicate-b.png" />

<img src="marker.png" __imageFrom={(() => { throw new Error("marker-must-not-run") })()} />

<Remote><img src="nested.png" alt="Protected child" /></Remote>
`;
  const projection = await projectFluidSource(source,'mdx',undefined,{label:'Loading component'});
  const html = render(projection.code);
  expect(html).toContain('data-static-image="normal.png"');
  expect(html).toContain('data-static-image="literal.png"');
  expect(html.match(/data-static-image=/g)).toHaveLength(2);
  expect(html).not.toContain('<img');
  for (const forbidden of ['esm-must-not-run','handler-must-not-run','src-must-not-run','spread-must-not-run','marker-must-not-run','duplicate-a.png','duplicate-b.png','nested.png']) expect(projection.code).not.toContain(forbidden);
  expect(projection.components.modules).toEqual([]);
  expect(projection.components.code).toEqual([]);
});
