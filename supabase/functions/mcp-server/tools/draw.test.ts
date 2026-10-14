import { assert, assertEquals, assertMatch, assertStringIncludes } from 'jsr:@std/assert@1.0.19'
import { Client } from 'npm:@modelcontextprotocol/client@2.0.0'
import { type CallToolResult, InMemoryTransport, McpServer } from 'npm:@modelcontextprotocol/server@2.0.0'
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.108.2'

import { drawElement, drawingSvg, parseDrawing } from './drawingSvg.ts'
import { registerTools, type ToolContext } from './index.ts'

// draw on a real McpServer through a real MCP client, with a stand-in for
// the project's files: read by path, and saved by save_files with the
// database's version check (a put whose base_version is not the file's
// version, or that has none where a file exists, is a conflict).

const PROJECT = '6f1c2d3e-4b5a-4c6d-8e7f-901a2b3c4d5e'
const PATH = 'drawings/flow.excalidraw'

type Stored = { content: string; version: number }
type Element = Record<string, unknown>
type Save = { project_id: string; mutation_id: string; changes: { op: string; path: string; content: string; base_version?: number }[] }

/**
 * The project's files by path. `interrupt` runs as each save arrives, before
 * its version check, so a test can save for someone else in between.
 */
function project(files: Record<string, Stored>, interrupt?: (project: { save: (path: string, content: string) => void }) => void) {
  const saves: Save[] = []
  let revision = Math.max(0, ...Object.values(files).map((file) => file.version))
  const save = (path: string, content: string) => {
    revision++
    files[path] = { content, version: revision }
  }
  const supabase = {
    from(table: string) {
      const eq: Record<string, unknown> = {}
      const builder = {
        select: () => builder,
        eq: (key: string, value: unknown) => ((eq[key] = value), builder),
        maybeSingle: () => {
          assertEquals([table, eq.project_id], ['project_files', PROJECT])
          const file = files[eq.path as string]
          return Promise.resolve({ data: file ? { ...file } : null, error: null })
        },
      }
      return builder
    },
    rpc(name: string, args: Save) {
      assertEquals(name, 'save_files')
      saves.push(JSON.parse(JSON.stringify(args)))
      interrupt?.({ save })
      const [change] = args.changes
      const file = files[change.path]
      if (file?.version !== change.base_version) {
        const current = file ? { version: file.version, content: file.content } : null
        return Promise.resolve({ data: { status: 'conflict', conflicts: [{ path: change.path, base_version: change.base_version ?? null, current }] }, error: null })
      }
      save(change.path, change.content)
      return Promise.resolve({ data: { status: 'saved', changes: [{ op: 'put', path: change.path, version: revision }] }, error: null })
    },
  } as unknown as SupabaseClient
  return { supabase, files, saves, save }
}

async function draw(supabase: SupabaseClient, args: Record<string, unknown>): Promise<CallToolResult> {
  const server = new McpServer({ name: 'test', version: '1.0.0' })
  registerTools(server, { supabase } as unknown as ToolContext)
  const client = new Client({ name: 'test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    return (await client.callTool({ name: 'draw', arguments: { project_id: PROJECT, path: PATH, ...args } })) as CallToolResult
  } finally {
    await client.close()
    await server.close()
  }
}

const elementsOf = (content: string) => JSON.parse(content).elements as Element[]
const text = (result: CallToolResult) => (result.content[0] as { text: string }).text

/** A drawing as the app saves one: every field, some the app does not know, a deleted text, and a gap in the indices. */
const BEFORE = JSON.stringify(
  {
    type: 'excalidraw',
    version: 2,
    source: 'https://excalidraw.com',
    elements: [
      {
        id: 'browser', type: 'rectangle', x: 0, y: 0, width: 180, height: 80, angle: 0, strokeColor: '#1e1e1e', backgroundColor: '#a5d8ff',
        fillStyle: 'hachure', strokeWidth: 1, strokeStyle: 'solid', roughness: 0, opacity: 100, groupIds: ['g1'], frameId: null, index: 'a0',
        roundness: { type: 3 }, seed: 11, version: 4, versionNonce: 12, isDeleted: false, boundElements: [{ type: 'text', id: 'old-label' }],
        updated: 1, link: null, locked: false, customData: { kept: true },
      },
      {
        id: 'old-label', type: 'text', x: 10, y: 10, width: 60, height: 25, angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent',
        fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, index: 'a1',
        roundness: null, seed: 13, version: 9, versionNonce: 14, isDeleted: true, boundElements: null, updated: 1, link: null, locked: false,
        text: 'Old', fontSize: 20, fontFamily: 5, textAlign: 'left', verticalAlign: 'top', containerId: 'browser', originalText: 'Old',
        autoResize: true, lineHeight: 1.25,
      },
      {
        id: 'database', type: 'ellipse', x: 400, y: 0, width: 160, height: 80, angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent',
        fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'dashed', roughness: 1, opacity: 60, groupIds: [], frameId: null, index: 'a5',
        roundness: null, seed: 15, version: 2, versionNonce: 16, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false,
      },
    ],
    appState: { viewBackgroundColor: '#ffffff', gridSize: 20 },
    files: {},
    plugin: { note: 'unknown top-level fields stay' },
  },
  null,
  2
)

Deno.test('draw creates a new drawing whose elements have what Excalidraw and the server need to draw them', async () => {
  const { supabase, files, saves } = project({})
  const result = await draw(supabase, {
    elements: [
      { id: 'draft', type: 'rectangle', x: 0, y: 0, width: 180, height: 80, backgroundColor: '#fff3bf' },
      { id: 'draft-label', type: 'text', x: 50, y: 27.5, text: 'Draft', containerId: 'draft' },
    ],
  })
  assert(!result.isError, text(result))
  assertEquals(result.structuredContent, { path: PATH, version: 1, added: 2, element_count: 2 })
  // One save, as write_file makes it: a put with no version, which only creates.
  assertEquals(saves.map((save) => save.changes.map(({ op, path, base_version }) => ({ op, path, base_version }))), [[{ op: 'put', path: PATH, base_version: undefined }]])
  assertMatch(saves[0].mutation_id, /^[0-9a-f-]{36}$/)

  const scene = JSON.parse(files[PATH].content)
  assertEquals({ ...scene, elements: [] }, { type: 'excalidraw', version: 2, elements: [], appState: { viewBackgroundColor: '#ffffff' }, files: {} })
  const [box, label] = scene.elements as Element[]
  for (const element of [box, label]) {
    for (const field of ['seed', 'versionNonce', 'updated']) assert(Number.isInteger(element[field]), `${element.id}.${field}`)
  }
  const { seed: _s, versionNonce: _n, updated: _u, ...shape } = box
  assertEquals(shape, {
    id: 'draft', type: 'rectangle', x: 0, y: 0, width: 180, height: 80, angle: 0, strokeColor: '#1e1e1e', backgroundColor: '#fff3bf',
    fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, index: 'a0',
    roundness: null, version: 1, isDeleted: false, boundElements: [{ type: 'text', id: 'draft-label' }], link: null, locked: false,
  })
  // A label: Excalifont, Excalidraw's line height for it, and centred in its shape.
  assertEquals(
    { ...label, seed: 0, versionNonce: 0, updated: 0, width: 0 },
    {
      id: 'draft-label', type: 'text', x: 50, y: 27.5, width: 0, height: 25, angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent',
      fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, index: 'a1',
      roundness: null, seed: 0, version: 1, versionNonce: 0, isDeleted: false, boundElements: [], updated: 0, link: null, locked: false,
      text: 'Draft', fontSize: 20, fontFamily: 5, textAlign: 'center', verticalAlign: 'middle', containerId: 'draft', originalText: 'Draft',
      autoResize: true, lineHeight: 1.25,
    }
  )
  assert((label.width as number) > 0)

  // The server's renderer draws both, as the chat card and show_file would.
  const types = new Map(scene.elements.map((element: Element) => [element.id, element.type]))
  for (const element of scene.elements) assert(drawElement(element, types), `${element.id} draws nothing`)
  const drawn = drawingSvg(parseDrawing(files[PATH].content))
  assert('svg' in drawn)
  assertStringIncludes(drawn.svg, '>Draft</text>')
})

Deno.test('draw adds after the last element, and changes nothing already there but the shapes it binds to', async () => {
  const { supabase, files, saves } = project({ [PATH]: { content: BEFORE, version: 7 } })
  const result = await draw(supabase, {
    elements: [
      { id: 'browser-label', type: 'text', x: 60, y: 27.5, width: 60, height: 25, text: 'Browser', containerId: 'browser' },
      { id: 'query', type: 'arrow', x: 188, y: 40, points: [[0, 0], [204, 0]], startBinding: { elementId: 'browser' }, endBinding: { elementId: 'database', focus: 0.1, gap: 4 } },
    ],
  })
  assert(!result.isError, text(result))
  assertEquals(result.structuredContent, { path: PATH, version: 8, added: 2, element_count: 4 })
  assertEquals(saves[0].changes[0].base_version, 7)

  const before = JSON.parse(BEFORE)
  const after = JSON.parse(files[PATH].content)
  // The rest of the file as it was, in the same order.
  assertEquals(Object.keys(after), Object.keys(before))
  assertEquals({ ...after, elements: null }, { ...before, elements: null })
  const [browser, oldLabel, database, label, arrow] = after.elements as Element[]
  // Each element already there is the same, field for field and in order,
  // except a shape's boundElements, which gain what this call bound to it.
  const unbound = ({ boundElements: _, ...rest }: Element) => JSON.stringify(rest)
  assertEquals(unbound(browser), unbound(before.elements[0]))
  assertEquals(JSON.stringify(oldLabel), JSON.stringify(before.elements[1]))
  assertEquals(unbound(database), unbound(before.elements[2]))
  assertEquals(Object.keys(browser), Object.keys(before.elements[0]))
  assertEquals(browser.boundElements, [{ type: 'text', id: 'old-label' }, { type: 'text', id: 'browser-label' }, { type: 'arrow', id: 'query' }])
  assertEquals(database.boundElements, [{ type: 'arrow', id: 'query' }])

  // The new elements continue the indices after the scene's last, a5.
  assertEquals([label.index, arrow.index], ['a6', 'a7'])
  assertEquals([label.width, label.height], [60, 25])
  assertEquals(
    [arrow.width, arrow.height, arrow.endArrowhead, arrow.startArrowhead, arrow.elbowed, arrow.lastCommittedPoint],
    [204, 0, 'arrow', null, false, null]
  )
  assertEquals([arrow.startBinding, arrow.endBinding], [{ focus: 0, gap: 8, elementId: 'browser' }, { focus: 0.1, gap: 4, elementId: 'database' }])
})

Deno.test('draw refuses what it cannot add, and saves nothing', async () => {
  const refusals: [Record<string, unknown>, string][] = [
    [{ elements: [{ id: 'browser', type: 'rectangle', x: 0, y: 0, width: 10, height: 10 }] }, 'The drawing already has an element "browser"'],
    // A deleted element keeps its id in the file.
    [{ elements: [{ id: 'old-label', type: 'text', x: 0, y: 0, text: 'Hi' }] }, 'The drawing already has an element "old-label"'],
    [
      { elements: [{ id: 'cache', type: 'rectangle', x: 0, y: 0, width: 10, height: 10 }, { id: 'cache', type: 'text', x: 0, y: 0, text: 'Cache' }] },
      'The id "cache" is used twice',
    ],
    [{ elements: [{ id: 'cache-label', type: 'text', x: 0, y: 0, text: 'Cache', containerId: 'cache' }] }, 'is bound to "cache", which is not in the drawing'],
    [{ elements: [{ id: 'gone', type: 'text', x: 0, y: 0, text: 'Hi', containerId: 'old-label' }] }, 'is bound to "old-label", which is not in the drawing'],
    [{ elements: [{ id: 'cache', type: 'rectangle', x: 0, y: 0 }] }, 'The rectangle "cache" needs a width and a height'],
    [{ elements: [{ id: 'link', type: 'arrow', x: 0, y: 0 }] }, 'The arrow "link" needs points'],
    [{ elements: [{ id: 'cache', type: 'rectangle', x: 0, y: 0, width: 10, height: 10 }], base_version: 6 }, 'changed since version 6: it is now version 7'],
    [{ path: 'notes/flow.excalidraw.md', elements: [{ id: 'cache', type: 'rectangle', x: 0, y: 0, width: 10, height: 10 }] }, 'use write_file'],
  ]
  for (const [args, message] of refusals) {
    const { supabase, files, saves } = project({ [PATH]: { content: BEFORE, version: 7 } })
    const result = await draw(supabase, args)
    assert(result.isError, message)
    assertStringIncludes(text(result), message)
    assertEquals(saves, [], message)
    assertEquals(files[PATH], { content: BEFORE, version: 7 })
  }
})

Deno.test('a later call binds a label and an arrow to shapes an earlier call added, and the server draws them', async () => {
  const { supabase, files } = project({})
  const first = await draw(supabase, {
    elements: [
      { id: 'worker', type: 'rectangle', x: 0, y: 0, width: 160, height: 80 },
      { id: 'store', type: 'diamond', x: 300, y: 0, width: 160, height: 80 },
    ],
  })
  assertEquals(first.structuredContent, { path: PATH, version: 1, added: 2, element_count: 2 })
  const shapes = elementsOf(files[PATH].content)

  const second = await draw(supabase, {
    base_version: 1,
    elements: [
      { id: 'worker-label', type: 'text', x: 45, y: 27.5, text: 'Worker', containerId: 'worker' },
      { id: 'worker-to-store', type: 'arrow', x: 168, y: 40, points: [[0, 0], [124, 0]], startBinding: { elementId: 'worker' }, endBinding: { elementId: 'store' } },
    ],
  })
  assertEquals(second.structuredContent, { path: PATH, version: 2, added: 2, element_count: 4 })
  const [worker, store, label, arrow] = elementsOf(files[PATH].content)
  assertEquals(worker, { ...shapes[0], boundElements: [{ type: 'text', id: 'worker-label' }, { type: 'arrow', id: 'worker-to-store' }] })
  assertEquals(store, { ...shapes[1], boundElements: [{ type: 'arrow', id: 'worker-to-store' }] })
  assertEquals([label.containerId, arrow.startBinding, arrow.endBinding], ['worker', { focus: 0, gap: 8, elementId: 'worker' }, { focus: 0, gap: 8, elementId: 'store' }])
  assertEquals(elementsOf(files[PATH].content).map((element) => element.index), ['a0', 'a1', 'a2', 'a3'])

  const drawn = drawingSvg(parseDrawing(files[PATH].content))
  assert('svg' in drawn)
  assertStringIncludes(drawn.svg, '>Worker</text>')
})

Deno.test('draw adds once more to a drawing someone saved in between, and returns the conflict when it happens again', async () => {
  const theirs = (content: string) => {
    const scene = JSON.parse(content)
    scene.elements.push({ ...scene.elements[2], id: `theirs-${scene.elements.length}`, index: `a${scene.elements.length + 5}` })
    return JSON.stringify(scene, null, 2)
  }
  const cache = { id: 'cache', type: 'rectangle', x: 200, y: 200, width: 120, height: 60 }

  // Once: the person saves first; draw reads their version and adds to it.
  let interruptions = 1
  const once = project({ [PATH]: { content: BEFORE, version: 7 } }, ({ save }) => {
    if (interruptions-- > 0) save(PATH, theirs(once.files[PATH].content))
  })
  const result = await draw(once.supabase, { elements: [cache] })
  assert(!result.isError, text(result))
  assertEquals(result.structuredContent, { path: PATH, version: 9, added: 1, element_count: 4 })
  assertEquals(once.saves.map((save) => save.changes[0].base_version), [7, 8])
  const saved = elementsOf(once.files[PATH].content)
  assertEquals(saved.map((element) => element.id), ['browser', 'old-label', 'database', 'theirs-3', 'cache'])
  assertEquals(saved[3], elementsOf(theirs(BEFORE))[3])
  assertEquals(saved[4].index, 'a9')

  // Twice: nothing of draw's is saved, and it says the drawing changed.
  const twice = project({ [PATH]: { content: BEFORE, version: 7 } }, ({ save }) => save(PATH, theirs(twice.files[PATH].content)))
  const conflict = await draw(twice.supabase, { elements: [cache] })
  assert(conflict.isError)
  assertEquals(text(conflict), `${PATH} changed while the elements were being added: it is now version 9. Nothing was saved. Call draw again.`)
  assertEquals(twice.saves.length, 2)
  assert(!elementsOf(twice.files[PATH].content).some((element) => element.id === 'cache'))
})
