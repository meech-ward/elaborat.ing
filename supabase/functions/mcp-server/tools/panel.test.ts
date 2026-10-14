import { assert, assertEquals, assertMatch, assertStringIncludes } from 'jsr:@std/assert@1.0.19'
import { Client } from 'npm:@modelcontextprotocol/client@2.0.0'
import { type CallToolResult, InMemoryTransport, McpServer } from 'npm:@modelcontextprotocol/server@2.0.0'
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.108.2'

import { FILE_VIEW_META } from './fileView.ts'
import { registerTools, type ToolContext } from './index.ts'
import { OLD_PANEL_VIEW_URIS, PANEL_META_KEY, PANEL_PASS_KEY, PANEL_VIEW_HTML, PANEL_VIEW_URI } from './panel.ts'

// open_panel, panel_pass, panel_origins and the view, on a real McpServer through a real MCP
// client, with a stand-in Supabase client that answers the project's title
// (as RLS would: only for a project the person can open) and mints a new
// pass for each call of mint_panel_pass (or fails, with `mintFails`).

const PROJECT = '6f1c2d3e-4b5a-4c6d-8e7f-901a2b3c4d5e'
const OTHER = '7a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'

async function withClient<T>(use: (client: Client, queries: unknown[][]) => Promise<T>, embedView = true, mintFails = false): Promise<T> {
  const queries: unknown[][] = []
  let minted = 0
  const supabase = {
    rpc(name: string, ...args: unknown[]) {
      queries.push(['rpc', name, ...args])
      if (mintFails) return Promise.resolve({ data: null, error: { message: 'database unavailable' } })
      return Promise.resolve({ data: name === 'mint_panel_pass' ? (++minted).toString(16).padStart(64, 'a') : null, error: null })
    },
    from(table: string) {
      const query: unknown[] = ['from', table]
      queries.push(query)
      const builder = {
        select: (...args: unknown[]) => (query.push('select', ...args), builder),
        eq: (...args: unknown[]) => (query.push('eq', ...args), builder),
        maybeSingle: () => Promise.resolve({ data: query.includes(PROJECT) ? { title: 'Launch plan' } : null, error: null }),
      }
      return builder
    },
  } as unknown as SupabaseClient
  const server = new McpServer({ name: 'test', version: '1.0.0' })
  registerTools(server, { supabase, userClaims: { id: 'me' } } as unknown as ToolContext, { embedView })
  const client = new Client({ name: 'test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    return await use(client, queries)
  } finally {
    await client.close()
    await server.close()
  }
}

const call = (client: Client, args: Record<string, unknown>) => client.callTool({ name: 'open_panel', arguments: args }) as Promise<CallToolResult>
const text = (result: CallToolResult) => (result.content[0]?.type === 'text' ? result.content[0].text : '')

Deno.test('open_panel opens from the sidebar and a conversation panel, and its view may frame only the app', async () => {
  await withClient(async (client) => {
    const tool = (await client.listTools()).tools.find((entry) => entry.name === 'open_panel')
    assert(tool, 'open_panel is listed')
    assertEquals(tool.title, 'Projects')
    assertEquals(tool.annotations, { readOnlyHint: true, destructiveHint: false, openWorldHint: false })
    assertEquals(tool._meta, {
      ui: { resourceUri: PANEL_VIEW_URI, visibility: ['model', 'app'] },
      'openai/ui': { entrypoints: [{ type: 'global' }, { type: 'thread' }] },
      'openai/widgetAccessible': true,
    })
    const [icon] = tool.icons ?? []
    assertEquals(icon?.mimeType, 'image/svg+xml')
    const svg = atob(String(icon?.src).replace('data:image/svg+xml;base64,', ''))
    assertStringIncludes(svg, 'viewBox="0 0 20 20"')
    assertStringIncludes(svg, 'stroke="currentColor"')

    const { contents } = await client.readResource({ uri: PANEL_VIEW_URI })
    for (const old of OLD_PANEL_VIEW_URIS) {
      const { contents: earlier } = await client.readResource({ uri: old })
      const [earlierView] = earlier as { uri: string; text: string }[]
      assertEquals(earlierView.uri, old)
      assertStringIncludes(earlierView.text, 'panel_origins')
    }
    const [view] = contents as { uri: string; mimeType: string; text: string; _meta: Record<string, unknown> & { ui: Record<string, unknown> } }[]
    assertEquals(view.mimeType, 'text/html;profile=mcp-app')
    assertEquals(view._meta.ui.csp, { connectDomains: [], resourceDomains: [], frameDomains: ['https://elaborat.ing'] })
    assertEquals(view._meta['openai/widgetCSP'], {
      connect_domains: [],
      resource_domains: [],
      frame_domains: ['https://elaborat.ing'],
      redirect_domains: ['https://elaborat.ing'],
    })
    // One widget origin for the card and the panel, so the site allows one view origin per chat.
    assertEquals(view._meta['openai/widgetDomain'], FILE_VIEW_META['openai/widgetDomain'])
    assertStringIncludes(view.text, "elaborat.ing isn't switched on for this panel yet.")
    assertStringIncludes(view.text, 'Open in elaborat.ing')
    assertStringIncludes(view.text, '<summary>Details</summary>Origins to allow:<code id="origins">')
    // The view puts each page's pass in its fragment, never its query, and asks panel_pass for a new one.
    assertStringIncludes(view.text, '"#pass=" + pass')
    assertStringIncludes(view.text, 'callTool("panel_pass", {})')
    assert(!/[?&]pass=/.test(view.text), 'no pass in a query string')
    // It reports its origins to the server when it shows the fallback, and when the app opened.
    assertStringIncludes(view.text, 'callTool("panel_origins", args)')
    assertStringIncludes(view.text, 'if (!reportedBlocked) { reportedBlocked = true; reportOrigins(false); }')
    assertStringIncludes(view.text, 'if (!reportedOk) { reportedOk = true; reportOrigins(true); }')
  })
})

/** Runs `use` with console.log captured: the lines it printed. */
async function withLog<T>(use: () => Promise<T>): Promise<{ lines: string[]; value: T }> {
  const lines: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '))
  try {
    return { lines, value: await use() }
  } finally {
    console.log = original
  }
}

Deno.test('panel_origins is for the view only, and logs one line with the caller and the origins', async () => {
  await withClient(async (client, queries) => {
    const tool = (await client.listTools()).tools.find((entry) => entry.name === 'panel_origins')
    assert(tool, 'panel_origins is listed')
    assertEquals(tool._meta, { ui: { visibility: ['app'] }, 'openai/widgetAccessible': true })
    assertEquals(tool.annotations, { readOnlyHint: false, destructiveHint: false, openWorldHint: false })

    const origins = 'https://a1b2c3.web-sandbox.example https://chat.example'
    const { lines, value: result } = await withLog(
      () => client.callTool({ name: 'panel_origins', arguments: { origins } }) as Promise<CallToolResult>
    )
    assert(!result.isError, JSON.stringify(result))
    assertEquals(lines.map((line) => JSON.parse(line)), [{ event: 'panel_origins', user: 'me', origins }])
    assertEquals(result._meta, undefined)
    assertEquals(result.structuredContent, undefined)
    assertEquals(text(result), 'Noted.')

    const ok = await withLog(() => client.callTool({ name: 'panel_origins', arguments: { origins, ok: true } }) as Promise<CallToolResult>)
    assert(!ok.value.isError, JSON.stringify(ok.value))
    assertEquals(ok.lines.map((line) => JSON.parse(line)), [{ event: 'panel_ok', user: 'me', origins }])
    assertEquals(queries, [], 'it reads and writes nothing in Supabase')
  })
})

Deno.test('panel_origins takes only https origins, one space apart, at most ten, and logs nothing otherwise', async () => {
  await withClient(async (client) => {
    const ten = Array.from({ length: 10 }, (_, index) => `https://host${index}.example`).join(' ')
    const fine = await withLog(() => client.callTool({ name: 'panel_origins', arguments: { origins: ten } }) as Promise<CallToolResult>)
    assert(!fine.value.isError, JSON.stringify(fine.value))
    assertEquals(fine.lines.length, 1)

    const bad = [
      '',
      ' ',
      'http://chat.example',
      'https://chat.example/',
      'https://chat.example/path',
      'https://chat.example?q=1',
      'https://chat.example#x',
      'https://user:pw@chat.example',
      'https://chat.example  https://other.example',
      'chat.example',
      'javascript:alert(1)',
      `${ten} https://host10.example`,
    ]
    for (const origins of bad) {
      const { lines, value } = await withLog(() => client.callTool({ name: 'panel_origins', arguments: { origins } }) as Promise<CallToolResult>)
      assert(value.isError, `accepted ${JSON.stringify(origins)}`)
      assertEquals(lines, [], `logged ${JSON.stringify(origins)}`)
    }
    const missing = await withLog(() => client.callTool({ name: 'panel_origins', arguments: {} }) as Promise<CallToolResult>)
    assert(missing.value.isError, 'accepted no origins')
    assertEquals(missing.lines, [])
  })
})

Deno.test('panel_origins logs what the host reported about the view, numbers and short strings only', async () => {
  await withClient(async (client) => {
    const origins = 'https://chat.example'
    const report = (host: unknown) => withLog(() => client.callTool({ name: 'panel_origins', arguments: { origins, ok: true, host } }) as Promise<CallToolResult>)
    const host = {
      display_mode: 'fullscreen',
      safe_area: { top: 80, right: 0, bottom: 12.5, left: 0 },
      openai_safe_area: { top: 0 },
      container: { width: 1200, max_height: 900, label: 'dropped' },
      window: { width: 1280, height: 800 },
      email: 'dropped@example.com',
    }
    const fine = await report(host)
    assert(!fine.value.isError, JSON.stringify(fine.value))
    // Fields it does not know are dropped.
    const logged = { display_mode: 'fullscreen', safe_area: host.safe_area, openai_safe_area: host.openai_safe_area, container: { width: 1200, max_height: 900 }, window: host.window }
    assertEquals(fine.lines.map((line) => JSON.parse(line)), [{ event: 'panel_ok', user: 'me', origins, host: logged }])

    const bad = [
      'fullscreen',
      { display_mode: 'x'.repeat(33) },
      { display_mode: 'full screen' },
      { display_mode: 'someone@example.com' },
      { display_mode: 3 },
      { safe_area: { top: '80' } },
      { safe_area: [80] },
      { window: { width: 1e6 } },
      { container: { height: -1e6 } },
    ]
    for (const value of bad) {
      const { lines, value: result } = await report(value)
      assert(result.isError, `accepted ${JSON.stringify(value)}`)
      assertEquals(lines, [], `logged ${JSON.stringify(value)}`)
    }
  })
})

Deno.test('panel_pass is for the view only, and gives it a new pass in _meta alone', async () => {
  await withClient(async (client, queries) => {
    const tool = (await client.listTools()).tools.find((entry) => entry.name === 'panel_pass')
    assert(tool, 'panel_pass is listed')
    assertEquals(tool._meta, { ui: { visibility: ['app'] }, 'openai/widgetAccessible': true })
    // It adds a short-lived row, and changes nothing of the person's.
    assertEquals(tool.annotations, { readOnlyHint: false, destructiveHint: false, openWorldHint: false })

    const first = (await client.callTool({ name: 'panel_pass', arguments: {} })) as CallToolResult
    const second = (await client.callTool({ name: 'panel_pass', arguments: {} })) as CallToolResult
    assert(!first.isError, JSON.stringify(first))
    const pass = first._meta?.[PANEL_PASS_KEY]
    assertMatch(String(pass), /^[0-9a-f]{64}$/)
    assert(second._meta?.[PANEL_PASS_KEY] !== pass, 'each call mints a new pass')
    assertEquals(first.structuredContent, undefined)
    assertEquals(text(first), 'A new pass for the panel.')
    assertEquals(queries, [['rpc', 'mint_panel_pass'], ['rpc', 'mint_panel_pass']])
  })
})

Deno.test('without a pass, open_panel and panel_pass are errors', async () => {
  await withClient(async (client) => {
    for (const name of ['open_panel', 'panel_pass']) {
      const result = (await client.callTool({ name, arguments: {} })) as CallToolResult
      assert(result.isError, JSON.stringify(result))
      assertEquals(result._meta?.[PANEL_PASS_KEY], undefined)
    }
  }, true, true)
})

Deno.test('with EMBED_VIEW_ENABLED false the tools and resources are as they were without the panel', async () => {
  const listed = (embedView: boolean) =>
    withClient(async (client) => ({
      tools: (await client.listTools()).tools,
      resources: (await client.listResources()).resources.map((resource) => resource.uri),
    }), embedView)
  const on = await listed(true)
  const off = await listed(false)
  const panelTools = ['open_panel', 'panel_pass', 'panel_origins']
  assertEquals(off.tools.map((tool) => tool.name).sort(), on.tools.map((tool) => tool.name).filter((name) => !panelTools.includes(name)).sort())
  assertEquals(off.tools, on.tools.filter((tool) => !panelTools.includes(tool.name)))
  assertEquals(off.resources, on.resources.filter((uri) => uri !== PANEL_VIEW_URI && !OLD_PANEL_VIEW_URIS.includes(uri)))
  assert(on.resources.includes(PANEL_VIEW_URI))
  assert(off.tools.every((tool) => !(tool._meta && 'openai/ui' in tool._meta)), 'no entrypoints without the panel')
})

Deno.test('with no arguments it opens the projects list, reading nothing, with a pass for the view alone', async () => {
  await withClient(async (client, queries) => {
    const result = await call(client, {})
    assert(!result.isError, JSON.stringify(result))
    assertEquals(text(result), 'Opened your projects beside the chat.')
    assertEquals(result.structuredContent, { url: 'https://elaborat.ing/' })
    const pass = String(result._meta?.[PANEL_PASS_KEY])
    assertMatch(pass, /^[0-9a-f]{64}$/)
    assertEquals(result._meta, { [PANEL_META_KEY]: '/embed', [PANEL_PASS_KEY]: pass })
    // What the model sees never holds it.
    assert(!JSON.stringify([result.content, result.structuredContent]).includes(pass))
    assertEquals(queries, [['rpc', 'mint_panel_pass']])
  })
})

Deno.test('with a project it reads its title as the user, and opens it or one of its files', async () => {
  await withClient(async (client, queries) => {
    const project = await call(client, { project_id: PROJECT })
    assert(!project.isError, JSON.stringify(project))
    assertEquals(text(project), 'Opened Launch plan beside the chat.')
    assertEquals(project.structuredContent, { url: `https://elaborat.ing/projects/${PROJECT}` })
    assertEquals(project._meta?.[PANEL_META_KEY], `/embed/projects/${PROJECT}`)
    assertMatch(String(project._meta?.[PANEL_PASS_KEY]), /^[0-9a-f]{64}$/)
    assertEquals(queries[0], ['from', 'projects', 'select', 'title', 'eq', 'id', PROJECT])

    const file = await call(client, { project_id: PROJECT, path: 'notes/a plan#1.mdx' })
    assertEquals(text(file), 'Opened notes/a plan#1.mdx in Launch plan beside the chat.')
    assertEquals(file.structuredContent, { url: `https://elaborat.ing/projects/${PROJECT}/notes/a%20plan%231.mdx` })
    assertEquals(file._meta?.[PANEL_META_KEY], `/embed/projects/${PROJECT}/notes/a%20plan%231.mdx`)
    assert(file._meta?.[PANEL_PASS_KEY] !== project._meta?.[PANEL_PASS_KEY], 'each result has a new pass')
  })
})

Deno.test('a project the user cannot open is an error, and so is a path without a project', async () => {
  await withClient(async (client, queries) => {
    const unknown = await call(client, { project_id: OTHER })
    assert(unknown.isError, JSON.stringify(unknown))
    assertStringIncludes(text(unknown), 'list_projects')
    assertEquals(unknown._meta, undefined, 'no pass for a project the user cannot open')

    const before = queries.length
    for (const args of [{ path: 'notes/a.mdx' }, { project_id: 'not-a-uuid' }, { project_id: PROJECT, path: '' }]) {
      const result = await call(client, args)
      assert(result.isError, `accepted ${JSON.stringify(args)}`)
    }
    assertEquals(queries.length, before, 'invalid input never reaches Supabase')
  })
})

// The view's own script, run against a stand-in page: the host's window above
// it (which keeps what the view posts), the app's frame inside it (which the
// test speaks for), and a clock the test moves. `openai` stands in for
// ChatGPT's window.openai.

type Posted = { jsonrpc: string; id?: number; method?: string; params?: Record<string, unknown> }
type Frame = { hidden: boolean; src: string; contentWindow: { postMessage(message: unknown, origin: string): void }; cloneNode(): Frame; parentNode: { replaceChild(next: Frame): void } }
type Listener = (event: { source: unknown; origin: string; data: unknown }) => void

const APP = 'https://elaborat.ing'
const LOCATION = 'elaborating-embed:location'

function runView(openai?: Record<string, unknown>) {
  const script = /<script>([\s\S]*)<\/script>/.exec(PANEL_VIEW_HTML)?.[1]
  if (!script) throw new Error('the view has no script')
  const posted: Posted[] = []
  const listeners: Record<string, Listener[]> = {}
  const host = { postMessage: (message: Posted) => void posted.push(message) }
  // Each page the view frames is a new frame, with a window of its own.
  const newFrame = (): Frame => ({
    hidden: true,
    src: '',
    contentWindow: { postMessage() {} },
    cloneNode: () => newFrame(),
    parentNode: { replaceChild: (next) => void (frame = next) },
  })
  let frame = newFrame()
  const element = () => ({ hidden: true, textContent: '', onclick: null })
  const elements: Record<string, unknown> = { app: frame, fallback: element(), origins: element(), open: element() }
  const timers = new Map<number, { at: number; run: () => void }>()
  let now = 0
  let nextTimer = 1
  const page = {
    parent: host,
    openai,
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener: (type: string, listener: Listener) => void (listeners[type] ??= []).push(listener),
    open() {},
  }
  const document = { getElementById: (id: string) => elements[id], documentElement: { style: {}, dataset: {} }, body: { style: {} }, referrer: '' }
  const location = { origin: 'https://view.example', ancestorOrigins: ['https://chat.example'] }
  new Function('window', 'document', 'location', 'setTimeout', 'clearTimeout', script)(
    page,
    document,
    location,
    (run: () => void, ms = 0) => (timers.set(nextTimer, { at: now + ms, run }), nextTimer++),
    (id: number) => void timers.delete(id)
  )
  // Lets the view's promises run.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  const dispatch = async (source: unknown, origin: string, data: unknown) => {
    for (const listener of listeners.message ?? []) listener({ source, origin, data })
    await settle()
  }
  const fromHost = (data: unknown) => dispatch(host, 'https://chat.example', data)
  return {
    posted,
    frame: () => frame,
    fromHost,
    fromApp: (data: unknown, from: { source?: unknown; origin?: string } = {}) => dispatch(from.source ?? frame.contentWindow, from.origin ?? APP, data),
    /** Answers the view's last request for `method`. */
    answer: (method: string, result: unknown) => fromHost({ jsonrpc: '2.0', id: posted.findLast((message) => message.method === method)?.id, result }),
    /** Moves the clock on, running the view's timers that come due. */
    async tick(ms: number) {
      now += ms
      for (const [id, timer] of [...timers].sort(([, a], [, b]) => a.at - b.at)) if (timer.at <= now && timers.delete(id)) timer.run()
      await settle()
    },
    /** What the view told the model, each call's params in order. */
    told: () => posted.filter((message) => message.method === 'ui/update-model-context').map((message) => message.params),
  }
}

/** A view the host has initialized with `hostContext`, framing the app after the tool's result; the app has said it is ready. */
async function openView(hostContext: Record<string, unknown> = { theme: 'light', displayMode: 'fullscreen' }, openai?: Record<string, unknown>) {
  const view = runView(openai)
  await view.answer('ui/initialize', { hostCapabilities: {}, hostContext })
  const pass = 'a'.repeat(64)
  await view.fromHost({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { _meta: { [PANEL_META_KEY]: '/embed', [PANEL_PASS_KEY]: pass } } })
  assertEquals(view.frame().src, `${APP}/embed?theme=light#pass=${pass}`)
  await view.fromApp({ type: 'elaborating-embed:ready' })
  return view
}

const at = (file: { path: string; kind: string } | null, name = 'Test') => ({ type: LOCATION, project: { id: PROJECT, name }, file })
const context = (text: string) => ({ content: [{ type: 'text', text }] })
const OPEN = `The person has elaborat.ing open beside this chat: project "Test" (project_id ${PROJECT})`
const READ = 'they mean this file: read it with read_file before changing it.'

Deno.test('the view tells the model which project and file the person has open, once it settles, and only when it changes', async () => {
  const view = await openView()
  assertEquals(view.told(), [])

  await view.fromApp(at({ path: 'drawings/how-mcp-works.excalidraw', kind: 'drawing' }))
  await view.tick(299)
  assertEquals(view.told(), [], 'not before it settles')
  await view.tick(1)
  assertEquals(view.told(), [
    context(
      `${OPEN}, file "drawings/how-mcp-works.excalidraw", a drawing. When they say "this" or "the drawing", ${READ} ` +
        'Add to it with draw, one shape with its label and arrows per call, so they can watch it being drawn. ' +
        'Change or remove elements with write_file and base_version.'
    ),
  ])

  // The same again tells it nothing new; quick moves tell it only where they end.
  await view.fromApp(at({ path: 'drawings/how-mcp-works.excalidraw', kind: 'drawing' }))
  await view.tick(300)
  await view.fromApp(at({ path: 'notes/plan.mdx', kind: 'note' }))
  await view.tick(100)
  await view.fromApp(at({ path: 'notes/plan.md', kind: 'note' }))
  await view.tick(300)
  assertEquals(view.told().slice(1), [
    context(
      `${OPEN}, file "notes/plan.md", a note. When they say "this" or "the note", ${READ} ` +
        'Add to it with append_to_note, a section per call, so they can watch it being written. ' +
        'Change or remove text with write_file and base_version.'
    ),
  ])

  // A diagram, another file and an Obsidian drawing are changed with write_file; a project with no file open is named alone.
  const rest: [Record<string, unknown>, string][] = [
    [at({ path: 'diagrams/flow.d2', kind: 'diagram' }), `${OPEN}, file "diagrams/flow.d2", a diagram. When they say "this" or "the diagram", ${READ} Change it with write_file and base_version.`],
    [at({ path: 'data/list.json', kind: 'other' }), `${OPEN}, file "data/list.json", a file. When they say "this" or "the file", ${READ} Change it with write_file and base_version.`],
    [at({ path: 'Sketch.excalidraw.md', kind: 'drawing' }), `${OPEN}, file "Sketch.excalidraw.md", a drawing. When they say "this" or "the drawing", ${READ} Change it with write_file and base_version.`],
    [at(null), `${OPEN}, with no file open. When they say "this" or "the project", they mean this project.`],
    [at(null, 'Plan "B"'), `The person has elaborat.ing open beside this chat: project "Plan \\"B\\"" (project_id ${PROJECT}), with no file open. When they say "this" or "the project", they mean this project.`],
  ]
  for (const [location, text] of rest) {
    await view.fromApp(location)
    await view.tick(300)
    assertEquals(view.told().at(-1), context(text))
  }

  // Nothing open: an empty list, once.
  for (let time = 0; time < 2; time++) {
    await view.fromApp({ type: LOCATION, project: null, file: null })
    await view.tick(300)
  }
  assertEquals(view.told().length, 2 + rest.length + 1)
  assertEquals(view.told().at(-1), { content: [] })
})

Deno.test("the view takes a location only from the app's frame, and only one that checks out", async () => {
  const view = await openView()
  const good = at({ path: 'notes/plan.md', kind: 'note' })
  await view.fromApp(good, { origin: 'https://other.example' })
  await view.fromApp(good, { source: {} })
  await view.fromHost(good)
  const file = (path: unknown, kind: unknown = 'note') => ({ ...good, file: { path, kind } })
  const bad = [
    { ...good, project: null },
    { ...good, project: { id: 'not-a-project', name: 'Test' } },
    { ...good, project: { id: PROJECT } },
    { ...good, project: { id: PROJECT, name: ' ' } },
    { ...good, project: { id: PROJECT, name: 'x'.repeat(161) } },
    { ...good, project: { id: PROJECT, name: 7 } },
    { ...good, file: undefined },
    { type: LOCATION },
    file('notes/plan.md', 'sketch'),
    file('notes/plan.md', null),
    file(42),
    file(''),
    file('/notes/plan.md'),
    file('notes/'),
    file('notes//plan.md'),
    file('notes/../plan.md'),
    file('notes/.plan.md'),
    file('notes\\plan.md'),
    file('C:plan.md'),
    file('notes/plan\n.md'),
    file('x'.repeat(1025)),
  ]
  for (const data of bad) await view.fromApp(data)
  await view.tick(300)
  assertEquals(view.told(), [])

  // From the app's frame, it does.
  await view.fromApp(good)
  await view.tick(300)
  assertEquals(view.told().length, 1)
})

Deno.test('the view clears what it told the model when the app is no longer on screen', async () => {
  const view = await openView()
  await view.fromApp(at({ path: 'notes/plan.md', kind: 'note' }))
  await view.tick(300)
  assertEquals(view.told().length, 1)
  // The chat shows the view again: a new page loads, and the app does not say it is ready in time.
  await view.fromApp({ type: 'elaborating-embed:pass' })
  await view.answer('tools/call', { _meta: { [PANEL_PASS_KEY]: 'b'.repeat(64) } })
  assertEquals(view.frame().src, `${APP}/embed?theme=light#pass=${'b'.repeat(64)}`)
  await view.tick(10_000)
  await view.tick(300)
  assertEquals(view.told().length, 2)
  assertEquals(view.told().at(-1), { content: [] })
})

Deno.test('the view reports what the host said about its place, and panel_origins logs it as sent', async () => {
  const view = await openView(
    {
      theme: 'light',
      displayMode: 'fullscreen',
      safeAreaInsets: { top: 80, right: 0, bottom: 12.5, left: 0 },
      containerDimensions: { width: 1200, maxHeight: 900, label: 'not a number' },
      userAgent: 'not reported',
    },
    { safeArea: { insets: { top: 64, right: 0, bottom: 0, left: 0 } } }
  )
  const call = view.posted.findLast((message) => message.method === 'tools/call' && message.params?.name === 'panel_origins')
  const host = {
    display_mode: 'fullscreen',
    safe_area: { top: 80, right: 0, bottom: 12.5, left: 0 },
    openai_safe_area: { top: 64, right: 0, bottom: 0, left: 0 },
    container: { width: 1200, max_height: 900 },
    window: { width: 1280, height: 800 },
  }
  const origins = 'https://view.example https://chat.example'
  assertEquals(call?.params?.arguments, { origins, ok: true, host })

  // The server takes what the view sends as it is.
  await withClient(async (client) => {
    const { lines, value } = await withLog(() => client.callTool({ name: 'panel_origins', arguments: call?.params?.arguments as Record<string, unknown> }) as Promise<CallToolResult>)
    assert(!value.isError, JSON.stringify(value))
    assertEquals(lines.map((line) => JSON.parse(line)), [{ event: 'panel_ok', user: 'me', origins, host }])
  })
})
