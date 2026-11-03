import {expect, test} from 'bun:test'
import {notionHtml, sanitizeNotionHtml, type NotionAssetReference, type NotionHtmlOptions, type NotionSnapshotReference} from './notionHtml'

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='
const gif = 'data:image/gif;base64,R0lGODlhAgABAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAgABAAAIBQABAAgIACH5BAEKAAEALAAAAAACAAEAgQAA/wAAAAAAAAAAAAgFAAEACAgAOw=='
const convert = (source: string, options: Partial<NotionHtmlOptions> = {}) => notionHtml({source, path: 'notes/guide.mdx', format: 'mdx', ...options})

test('common Markdown produces semantic headings, emphasis, quotes, rules and code without executing it', async () => {
  const result = await convert('# Guide\n\nA **strong** and *quiet* line with ~~old~~ and `inline <tag>`.\n\n> Quoted\n\n---\n\n```cpp\nif (x < 2) { alert("hello"); }\n```')
  expect(result.html).toContain('<h1>Guide</h1>')
  expect(result.html).toContain('<strong>strong</strong>')
  expect(result.html).toContain('<em>quiet</em>')
  expect(result.html).toContain('<del>old</del>')
  expect(result.html).toContain('<code>inline &lt;tag&gt;</code>')
  expect(result.html).toContain('<blockquote><p>Quoted</p></blockquote>')
  expect(result.html).toContain('<hr />')
  expect(result.html).toContain('<pre><code class="language-cpp">if (x &lt; 2) { alert(&quot;hello&quot;); }</code></pre>')
  expect(result.diagnostics).toEqual([])
})

test('nested lists, ordered starts, tasks and GFM table headers retain structure', async () => {
  const result = await convert('3. First\n   - Nested\n4. Next\n\n- [x] Done\n- [ ] Later\n\n| Name | State |\n| --- | --- |\n| Item | **Ready** |')
  expect(result.html).toContain('<ol start="3">')
  expect(result.html).toContain('<ul><li><p>Nested</p></li></ul>')
  expect(result.html).toContain('<input type="checkbox" disabled="disabled" checked="checked" />')
  expect(result.html).toContain('<input type="checkbox" disabled="disabled" />')
  expect(result.html).toContain('<thead><tr><th>Name</th><th>State</th></tr></thead>')
  expect(result.html).toContain('<tbody><tr><td>Item</td><td><strong>Ready</strong></td></tr></tbody>')
})

test('links rewrite relative targets and preserve readable text when a destination is unsafe', async () => {
  const seen: string[] = []
  const result = await convert('[Other](../other.md "Read more") [Web](https://example.com/a) [Bad](javascript:alert%281%29)', {
    rewriteLink: (href, path) => {seen.push(`${path}:${href}`); return href.startsWith('../') ? 'Other.html' : href},
  })
  expect(result.html).toContain('<a href="Other.html" title="Read more">Other</a>')
  expect(result.html).toContain('<a href="https://example.com/a">Web</a>')
  expect(result.html).toContain('Bad')
  expect(result.html).not.toContain('href="javascript:')
  expect(result.diagnostics.some(item => item.kind === 'unsafe-url')).toBe(true)
  expect(seen[0]).toBe('notes/guide.mdx:../other.md')
})

test('Markdown reference images keep descriptions, titles and exact authoritative ranges', async () => {
  const source = '\ufeff# Photo\n\n![An & image][photo]\n\n[photo]: ../images/a.png "A title"'
  const references: NotionAssetReference[] = []
  const result = await convert(source, {format: 'md', resolveAsset: async ref => {references.push(ref); return {src: 'assets/a.png'}}})
  expect(result.html).toContain('<img src="assets/a.png" alt="An &amp; image" />')
  expect(references).toHaveLength(1)
  expect(references[0]).toMatchObject({kind: 'image', src: '../images/a.png', alt: 'An & image', title: 'A title', sourcePath: 'notes/guide.mdx'})
  expect(source.slice(references[0].from, references[0].to)).toBe('![An & image][photo]')
  expect(result.diagnostics).toEqual([])
})

test('figures preserve rich captions in both source formats', async () => {
  const source = '<figure>\n\n![Screenshot](../images/a.png)\n\n<figcaption>\n\nA **clear** caption with [help](https://example.com).\n\n</figcaption>\n</figure>'
  for (const format of ['md', 'mdx'] as const) {
    const result = await convert(source, {format, resolveAsset: async () => ({src: 'assets/a.png'})})
    expect(result.html).toContain('<figure>')
    expect(result.html).toContain('<img src="assets/a.png" alt="Screenshot" />')
    expect(result.html).toContain('<figcaption><p>A <strong>clear</strong> caption with <a href="https://example.com">help</a>.</p></figcaption>')
    expect(result.diagnostics).toEqual([])
  }
})

test('only literal source-declared drawing and diagram embeds authorize asset callbacks', async () => {
  const refs: NotionAssetReference[] = []
  const source = '<Drawing src="drawings/one.excalidraw" />\n\n<Diagram src="diagrams/flow.d2" />\n\n<Drawing src={chosen} />\n\n```mdx\n<Drawing src="private.excalidraw" />\n```\n\n{/* <Drawing src="comment.excalidraw" /> */}'
  const result = await convert(source, {resolveAsset: async ref => {refs.push(ref); return {src: `assets/${ref.kind}.png`}}})
  expect(refs.map(ref => [ref.kind, ref.src])).toEqual([['drawing', 'drawings/one.excalidraw'], ['diagram', 'diagrams/flow.d2']])
  for (const ref of refs) expect(source.slice(ref.from, ref.to)).toBe(`<${ref.kind === 'drawing' ? 'Drawing' : 'Diagram'} src="${ref.src}" />`)
  expect(result.html).toContain('assets/drawing.png')
  expect(result.html).toContain('src={chosen}')
  expect(result.diagnostics).toHaveLength(1)
})

test('plain Markdown drawing tags use the same literal asset resolution', async () => {
  const refs: NotionAssetReference[] = []
  const result = await convert('<Drawing src="one.excalidraw" />\n\n<Diagram src="flow.d2" />', {format: 'md', resolveAsset: async ref => {refs.push(ref); return {src: 'assets/render.png'}}})
  expect(refs.map(ref => ref.kind)).toEqual(['drawing', 'diagram'])
  expect(result.html.match(/<img /g)).toHaveLength(2)
  expect(result.diagnostics).toEqual([])
})

test('computed resource references retain visible source even when a snapshot callback is available', async () => {
  const parts = ['<Drawing src={chosen} />', '<Diagram src={chosen} />', '<Document src={chosen} />', '<img src={chosen} alt="Computed" />']
  let snapshots = 0
  let reads = 0
  const result = await convert(parts.join('\n\n'), {
    snapshot: async () => {snapshots++; return {html: '<p>Preview unavailable</p>'}},
    resolveAsset: async () => {reads++; return {src: 'assets/unauthorized.png'}},
    resolveDocument: async () => {reads++; return {html: '<p>Unauthorized document</p>', diagnostics: []}},
  })
  expect(snapshots).toBe(0)
  expect(reads).toBe(0)
  expect(result.diagnostics).toHaveLength(parts.length)
  expect(result.diagnostics.every(item => item.kind === 'unsupported')).toBe(true)
  for (const part of parts) expect(result.html).toContain(part.replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'))
  expect(result.html).not.toContain('Preview unavailable')
})

test('document embeds expand through an explicit callback even when default-collapsed', async () => {
  const calls: string[] = []
  const result = await convert('<Document src="details.mdx" title="More detail" defaultCollapsed />', {
    resolveDocument: async ref => {calls.push(ref.src); return {html: '<p>Child body</p>', diagnostics: []}},
  })
  expect(calls).toEqual(['details.mdx'])
  expect(result.html).toBe('<section><h2>More detail</h2><p>Child body</p></section>')
  const invalid = await convert('<Document src={chosen} />\n\n<Document src="../private.mdx" />', {resolveDocument: async () => {throw new Error('Must not read')}})
  expect(invalid.diagnostics.every(item => item.kind === 'unsupported')).toBe(true)
  expect(invalid.html).toContain('source follows')
})

test('source modules, frontmatter and comments stay hidden and never execute', async () => {
  const source = '---\nprivate: hidden\n---\n\nimport {Widget} from "workspace:widget.mdx"\n\nexport const neverRun = (() => { throw new Error("do not run"); })()\n\n# Visible\n\n{/* hidden comment */}\n\nBody.'
  const result = await convert(source)
  expect(result.html).toBe('<h1>Visible</h1><p>Body.</p>')
  expect(result.diagnostics).toEqual([])
  const toml = await convert('+++\nprivate = "hidden"\n+++\n\nBody.')
  expect(toml.html).toBe('<p>Body.</p>')
})

test('standard built-ins preserve content from all tabs and side-by-side children', async () => {
  const result = await convert('<Note title="Remember">\n\nKeep **this**.\n\n</Note>\n\n<Tabs current="One">\n<Tab name="One">First</Tab>\n<Tab name="Two">Second</Tab>\n</Tabs>\n\n<SideBySide><Card><CardTitle>Title</CardTitle><CardContent>Detail</CardContent></Card><Instruction><Instruction.Action step={2}>Do it</Instruction.Action><Instruction.Implementation>Code</Instruction.Implementation></Instruction></SideBySide>')
  expect(result.html).toContain('<blockquote><p><strong>Remember</strong></p><p>Keep <strong>this</strong>.</p></blockquote>')
  expect(result.html).toContain('<h3>One</h3>First')
  expect(result.html).toContain('<h3>Two</h3>Second')
  expect(result.html).toContain('<h3>Title</h3>')
  expect(result.html).toContain('<strong>Step 2</strong>')
  expect(result.diagnostics).toEqual([])
})

test('custom components and expressions use exact source ranges or visibly keep source', async () => {
  const source = '\ufeff# Heading\n\n<CustomForm stage="good" />\n\nAnswer: {calculate()}.'
  const calls: NotionSnapshotReference[] = []
  const result = await convert(source, {snapshot: async ref => {calls.push(ref); return ref.source.startsWith('<CustomForm') ? {html: '<h2>Rendered form</h2><button>Submit</button>'} : null}})
  expect(result.html).toContain('<h2>Rendered form</h2><span>Submit</span>')
  expect(result.html).toContain('{calculate()}')
  expect(result.diagnostics.filter(item => item.kind === 'unsupported')).toHaveLength(1)
  expect(calls.map(ref => source.slice(ref.from, ref.to))).toEqual(['<CustomForm stage="good" />', '{calculate()}'])
  expect(calls.every(ref => ref.sourcePath === 'notes/guide.mdx')).toBe(true)
})

test('a built-in containing custom children uses its exact outer island snapshot once', async () => {
  const source = '<Card><CardTitle>Demo</CardTitle><CardContent><CustomForm /></CardContent></Card>'
  const calls: NotionSnapshotReference[] = []
  const result = await convert(source, {snapshot: async ref => {
    calls.push(ref)
    return ref.source === source ? {html: '<h3>Demo</h3><p>Rendered custom content</p>'} : null
  }})
  expect(calls).toHaveLength(1)
  expect(calls[0]).toMatchObject({from: 0, to: source.length, source})
  expect(result.html).toBe('<h3>Demo</h3><p>Rendered custom content</p>')
  expect(result.diagnostics).toEqual([])
})

test('a whole-container snapshot cannot hide a computed resource beside a custom child', async () => {
  const source = '<Card><Custom /><Drawing src={chosen} /></Card>'
  const calls: NotionSnapshotReference[] = []
  let reads = 0
  const result = await convert(source, {
    snapshot: async ref => {calls.push(ref); return ref.source === source ? {html: '<p>Outer preview placeholder</p>'} : null},
    resolveAsset: async () => {reads++; return {src: 'assets/unauthorized.png'}},
  })
  expect(calls.map(ref => ref.source)).toEqual(['<Custom />'])
  expect(reads).toBe(0)
  expect(result.html).not.toContain('Outer preview placeholder')
  expect(result.html).toContain('&lt;Custom /&gt;')
  expect(result.html).toContain('&lt;Drawing src={chosen} /&gt;')
  expect(result.diagnostics.filter(item => item.kind === 'unsupported')).toHaveLength(2)
})

test('missing assets and callback failures remain visible rather than dropping blocks', async () => {
  const result = await convert('![Important chart](chart.png)\n\n<Document src="missing.mdx" />\n\n<Unknown />', {
    resolveAsset: async () => {throw new Error('Not available')},
    resolveDocument: async () => null,
    snapshot: async () => {throw new Error('Capture unavailable')},
  })
  expect(result.html).toContain('[Important chart unavailable]')
  expect(result.html).toContain('[missing.mdx unavailable]')
  expect(result.html).toContain('&lt;Unknown /&gt;')
  expect(result.diagnostics).toHaveLength(3)
})

test('raw HTML is reconstructed through semantic tags, without document-owned attributes', async () => {
  const result = await convert('Text <strong onclick="bad()">**bold**</strong> and <a href="https://example.com" target="_blank">help</a>.\n\n<table style="color:red"><tr><td colspan="2" onmouseover="bad()">Cell</td></tr></table>', {format: 'md'})
  expect(result.html).toContain('<strong><strong>bold</strong></strong>')
  expect(result.html).toContain('<a href="https://example.com">help</a>')
  expect(result.html).toContain('<td colspan="2">Cell</td>')
  expect(result.html).not.toMatch(/onclick|onmouseover|target=|style=/)
})

test('captured forms retain headings and labels while values, scripts and dialogs are removed', async () => {
  const result = await sanitizeNotionHtml('<section><h2>Create account</h2><form action="https://evil.test" onsubmit="steal()"><label>Email<input type="email" value="private@example.com"></label><label>Password<input type="password" value="secret"></label><textarea>private draft</textarea><select><option value="secret-choice">Choice</option></select><button formaction="https://evil.test">Create account</button></form><script>steal()</script><dialog open>Hidden dialog</dialog></section>')
  expect(result.html).toContain('<h2>Create account</h2>')
  expect(result.html).toContain('Email')
  expect(result.html).toContain('Password')
  expect(result.html).toContain('<span>Create account</span>')
  expect(result.html).not.toMatch(/<form|<input|<textarea|<select|<button|<script|<dialog|action=|value=|private@example|secret|private draft|Hidden dialog|steal\(/)
  expect(result.diagnostics.length).toBeGreaterThan(0)
})

test('snapshot images can only become package assets after bounded raster validation', async () => {
  const seen: string[] = []
  const result = await sanitizeNotionHtml(`<img src="${png}" alt="A &amp; B"><img src="https://evil.test/track.png"><img src="data:image/svg+xml;base64,PHN2Zy8+"><img src="${gif}">`, {
    raster: async value => {seen.push(value); return 'assets/static.png'},
  })
  expect(seen).toEqual([png])
  expect(result.html).toContain('<img src="assets/static.png" alt="A &amp; B" />')
  expect(result.html).not.toContain('https://evil.test')
  expect(result.html).not.toContain('data:')
  expect(result.diagnostics).toHaveLength(3)
})

test('static snapshot SVG uses an inert namespaced clone and becomes a packaged raster image', async () => {
  const vectors: string[] = []
  const source = '<svg viewBox="0 0 20 10"><rect width="20" height="10" fill="red"/></svg>'
  const result = await sanitizeNotionHtml(source, {vector: async markup => {vectors.push(markup); return 'assets/chart.png'}})
  expect(result.html).toBe('<img src="assets/chart.png" alt="Component graphic" />')
  expect(vectors).toHaveLength(1)
  expect(vectors[0]).toContain('xmlns="http://www.w3.org/2000/svg"')
  expect(vectors[0]).toContain('viewBox="0 0 20 10"')
  expect(source).not.toContain('xmlns=')
  expect(result.diagnostics).toEqual([])
})

test('active or remote SVG never reaches the vector callback or exported markup', async () => {
  let calls = 0
  for (const source of [
    '<svg width="20" height="10"><script>throw new Error("must not execute")</script></svg>',
    '<svg width="20" height="10"><rect onclick="bad()"/></svg>',
    '<svg width="20" height="10"><image href="https://evil.test/track.png"/></svg>',
    '<svg width="20" height="10"><use href="https://evil.test/a.svg#id"/></svg>',
  ]) {
    const result = await sanitizeNotionHtml(source, {vector: async () => {calls++; return 'assets/unsafe.png'}})
    expect(result.html).toBe('<span>[Component graphic unavailable]</span>')
    expect(result.diagnostics[0].kind).toBe('missing-asset')
  }
  expect(calls).toBe(0)
})

test('vector conversion failure and unsafe output remain explicit without retaining raw SVG', async () => {
  const source = '<svg width="20" height="10"><rect width="20" height="10"/></svg>'
  for (const vector of [async () => {throw new Error('Raster unavailable')}, async () => 'https://evil.test/chart.png', async () => png]) {
    const result = await sanitizeNotionHtml(source, {vector})
    expect(result.html).toBe('<span>[Component graphic unavailable]</span>')
    expect(result.html).not.toContain('<svg')
    expect(result.diagnostics).toHaveLength(1)
  }
  const missing = await sanitizeNotionHtml(source)
  expect(missing.html).toBe('<span>[svg omitted]</span>')
  expect(missing.diagnostics[0].kind).toBe('unsupported')
})

test('a custom component snapshot passes the vector resolver through to its sanitizer', async () => {
  const result = await convert('<CustomChart />', {
    snapshot: async () => ({html: '<svg width="20" height="10"><path d="M0 0L20 10"/></svg>'}),
    vector: async () => 'assets/custom-chart.png',
  })
  expect(result.html).toBe('<img src="assets/custom-chart.png" alt="Component graphic" />')
  expect(result.diagnostics).toEqual([])
})

test('snapshot link obfuscation and unsafe resolver outputs never produce executable URLs', async () => {
  const result = await sanitizeNotionHtml('<a href="jav&#x61;script:alert(1)">One</a><a href="java&#10;script:alert(1)">Two</a><a href="%6aavascript%3aalert(1)">Three</a><a href="//evil.test">Four</a><a href="https://user:password@example.com">Five</a>')
  expect(result.html).toBe('OneTwoThreeFourFive')
  expect(result.diagnostics).toHaveLength(5)
  const asset = await convert('![Image](a.png)', {resolveAsset: async () => ({src: 'javascript:alert(1)'})})
  expect(asset.html).not.toContain('<img')
  expect(asset.diagnostics[0].kind).toBe('missing-asset')
  const raster = await sanitizeNotionHtml(`<img src="${png}">`, {raster: async () => '//evil.test/image.png'})
  expect(raster.html).not.toContain('<img')
})

test('hidden snapshot nodes and foreign executable content cannot reappear as active markup', async () => {
  const result = await sanitizeNotionHtml('<div hidden>hidden value</div><div aria-hidden="true">hidden icon</div><div style="display:none">hidden state</div><svg><script>bad()</script></svg><iframe srcdoc="bad()"></iframe><span style="background:url(https://evil.test)">Readable</span>')
  expect(result.html).not.toMatch(/hidden value|hidden icon|hidden state|<svg|<iframe|bad\(\)|style=|https:\/\/evil/)
  expect(result.html).toContain('<span>Readable</span>')
})

test('malformed snapshots never expose form values through a source fallback', async () => {
  const result = await sanitizeNotionHtml('<form><input value="private-value"><broken attr="')
  expect(result.html).not.toContain('private-value')
  expect(result.html).toContain('could not be converted')
  expect(result.diagnostics[0].kind).toBe('parse')
})

test('computed visibility uses a snapshot or visible fallback instead of silently hiding content', async () => {
  const result = await convert('<Card hidden={isHidden}>Visible detail</Card>')
  expect(result.html).toContain('Visible detail')
  expect(result.diagnostics[0].kind).toBe('unsupported')
})

test('cancellation propagates rather than being mistaken for an unavailable asset', async () => {
  const controller = new AbortController()
  await expect(convert('![A](a.png)', {signal: controller.signal, resolveAsset: async () => {controller.abort(); return {src: 'assets/a.png'}}})).rejects.toHaveProperty('name', 'AbortError')
  await expect(sanitizeNotionHtml('<p>Content</p>', {signal: controller.signal})).rejects.toHaveProperty('name', 'AbortError')
})

test('invalid MDX stays visible with a diagnostic and never executes a partial parse', async () => {
  const result = await convert('# Content\n\n<Unknown broken={')
  expect(result.diagnostics[0].kind).toBe('parse')
  expect(result.html).toContain('&lt;Unknown broken={')
})
