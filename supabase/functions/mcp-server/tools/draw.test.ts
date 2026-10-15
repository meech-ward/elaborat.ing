import { assert, assertAlmostEquals, assertEquals, assertMatch, assertStringIncludes } from 'jsr:@std/assert@1.0.19'
import { Client } from 'npm:@modelcontextprotocol/client@2.0.0'
import { type CallToolResult, InMemoryTransport, McpServer } from 'npm:@modelcontextprotocol/server@2.0.0'
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.108.2'

import { addElements, type NewElement } from './draw.ts'
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

Deno.test('draw gives a new rectangle rounded corners unless it asks for square ones', async () => {
  const { supabase, files } = project({})
  const result = await draw(supabase, {
    elements: [
      { id: 'round', type: 'rectangle', x: 0, y: 0, label: 'Round' },
      { id: 'square', type: 'rectangle', x: 300, y: 0, label: 'Square', roundness: null },
      { id: 'oval', type: 'ellipse', x: 600, y: 0, label: 'Oval' },
    ],
  })
  assert(!result.isError, text(result))
  const byId = new Map((JSON.parse(files[PATH].content).elements as Element[]).map((element) => [element.id, element]))
  assertEquals(['round', 'square', 'oval'].map((id) => byId.get(id)?.roundness), [{ type: 3 }, null, null])
})

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
    roundness: { type: 3 }, version: 1, isDeleted: false, boundElements: [{ type: 'text', id: 'draft-label' }], link: null, locked: false,
  })
  // A label: Excalifont, Excalidraw's line height for it, and centred in its
  // shape whatever x and y it was sent (five characters estimated 55 wide).
  assertEquals(
    { ...label, seed: 0, versionNonce: 0, updated: 0, width: 0 },
    {
      id: 'draft-label', type: 'text', x: 62.5, y: 27.5, width: 0, height: 25, angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent',
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
    // Only an arrow with from and to may leave out x and y.
    [{ elements: [{ id: 'cache', type: 'rectangle', width: 10, height: 10 }] }, 'The rectangle "cache" needs x and y'],
    [{ elements: [{ id: 'link', type: 'arrow' }] }, 'The arrow "link" needs from and to, or x, y and points'],
    // Labels: only on what can hold one, with some text, and with an id of their own.
    [{ elements: [{ id: 'note', type: 'text', x: 0, y: 0, text: 'Hi', label: 'Hi' }] }, 'The text "note" has a label, which only a rectangle, ellipse, diamond or arrow can hold'],
    [{ elements: [{ id: 'rule', type: 'line', x: 0, y: 0, points: [[0, 0], [90, 0]], label: 'Rule' }] }, 'The line "rule" has a label'],
    [{ elements: [{ id: 'cache', type: 'rectangle', x: 0, y: 0, label: ' ' }] }, 'The label of the rectangle "cache" is empty'],
    [{ elements: [{ id: 'old', type: 'rectangle', x: 0, y: 0, label: 'Old' }] }, 'already has an element "old-label", the id draw gives the label of "old"'],
    [
      { elements: [{ id: 'cache', type: 'rectangle', x: 0, y: 0, label: 'Cache' }, { id: 'cache-label', type: 'text', x: 0, y: 0, text: 'Cache' }] },
      'The id "cache-label" is used twice: draw gives it to the label of "cache"',
    ],
    // At most 50 elements a call, counting the labels draw adds: 26 labelled boxes are 52.
    [
      { elements: Array.from({ length: 26 }, (_, i) => ({ id: `box-${i}`, type: 'rectangle', x: i * 200, y: 400, label: `Box ${i}` })) },
      'These elements come to 52 with their labels, and draw adds at most 50 a call',
    ],
    // from and to: an arrow's, both, two shapes there are, and without points or bindings of its own.
    [{ elements: [{ id: 'link', type: 'arrow', from: 'nowhere', to: 'database' }] }, 'The arrow "link" goes from "nowhere", which is not in the drawing'],
    [{ elements: [{ id: 'link', type: 'arrow', from: 'browser', to: 'nowhere' }] }, 'The arrow "link" goes to "nowhere", which is not in the drawing'],
    [{ elements: [{ id: 'link', type: 'arrow', from: 'browser', to: 'old-label' }] }, 'The arrow "link" goes to "old-label", which is not in the drawing'],
    [{ elements: [{ id: 'loop', type: 'arrow', from: 'browser', to: 'browser' }] }, 'The arrow "loop" goes from "browser" to itself'],
    [{ elements: [{ id: 'link', type: 'arrow', from: 'browser' }] }, 'The arrow "link" needs both from and to'],
    [{ elements: [{ id: 'cache', type: 'rectangle', x: 0, y: 0, width: 10, height: 10, to: 'browser' }] }, 'The rectangle "cache" has from or to, which only an arrow takes'],
    [
      { elements: [{ id: 'link', type: 'arrow', from: 'browser', to: 'database', points: [[0, 0], [204, 0]] }] },
      'The arrow "link" has from and to, and points or a binding as well',
    ],
    [
      { elements: [{ id: 'link', type: 'arrow', from: 'browser', to: 'database', startBinding: { elementId: 'browser' } }] },
      'The arrow "link" has from and to, and points or a binding as well',
    ],
    [
      { elements: [{ id: 'rule', type: 'line', x: 0, y: 300, points: [[0, 0], [90, 0]] }, { id: 'link', type: 'arrow', from: 'browser', to: 'rule' }] },
      'The arrow "link" cannot go to the line "rule"',
    ],
    [
      { elements: [{ id: 'cache', type: 'rectangle', x: 0, y: 200, label: 'Cache' }, { id: 'link', type: 'arrow', from: 'browser', to: 'cache-label' }] },
      'The arrow "link" goes to "cache-label", the label of "cache". Nothing was saved. Name the shape, "cache", instead.',
    ],
    // 'browser' ends at x 180: a box 10 px to its right leaves less than the two 8 px gaps.
    [
      { elements: [{ id: 'near', type: 'rectangle', x: 190, y: 0, width: 100, height: 80 }, { id: 'link', type: 'arrow', from: 'browser', to: 'near' }] },
      'The arrow "link" has no room between "browser" and "near"',
    ],
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

Deno.test('a label sent at 0, 0 sits in the middle of its shape, and an arrow\'s label on the middle of its arrow', async () => {
  const { content } = addElements(null, [
    { id: 'box', type: 'rectangle', x: 100, y: 50, width: 200, height: 100 },
    { id: 'box-label', type: 'text', x: 0, y: 0, text: 'Hello', containerId: 'box' },
    { id: 'link', type: 'arrow', x: 0, y: 0, points: [[0, 0], [200, 100]] },
    { id: 'link-label', type: 'text', x: 0, y: 0, text: 'go', containerId: 'link' },
    { id: 'bend', type: 'arrow', x: 10, y: 10, points: [[0, 0], [40, 80], [100, 0]] },
    { id: 'bend-label', type: 'text', x: 0, y: 0, text: 'via', containerId: 'bend' },
  ] as NewElement[])
  const byId = new Map(elementsOf(content).map((element) => [element.id, element]))
  const at = (id: string) => [byId.get(id)!.x, byId.get(id)!.y]
  // 'Hello' is estimated 55 by 25: centred on the box's middle, (200, 100).
  assertEquals(at('box-label'), [172.5, 87.5])
  // 'go' is 22 by 25, on the straight arrow's middle, (100, 50).
  assertEquals(at('link-label'), [89, 37.5])
  // 'via' is 33 by 25, on the bent arrow's middle point, (50, 90).
  assertEquals(at('bend-label'), [33.5, 77.5])
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

/** addElements with Excalidraw's random seeds held still, so what two calls make can be compared. */
function addSteady(content: string | null, elements: unknown[]) {
  const random = Math.random
  Math.random = () => 0.25
  try {
    return addElements(content, elements as NewElement[], 1_700_000_000_000)
  } finally {
    Math.random = random
  }
}

/** Where an element's middle is. */
const middleOf = (element: Element) => [(element.x as number) + (element.width as number) / 2, (element.y as number) + (element.height as number) / 2]
/** Where an arrow starts and ends in the scene. */
const endsOf = (arrow: Element) => {
  const points = arrow.points as number[][]
  const [x, y] = [arrow.x as number, arrow.y as number]
  return [[x + points[0][0], y + points[0][1]], [x + points.at(-1)![0], y + points.at(-1)![1]]]
}

Deno.test('a shape sent with a label and no size is sized to fit the label, which is centred in it', async () => {
  const { supabase, files } = project({})
  const result = await draw(supabase, {
    elements: [
      { id: 'api', type: 'rectangle', x: 0, y: 0, label: 'API' },
      { id: 'auth', type: 'rectangle', x: 0, y: 200, label: 'Authentication service' },
      { id: 'db', type: 'ellipse', x: 400, y: 0, label: 'Database' },
      { id: 'valid', type: 'diamond', x: 400, y: 200, label: 'Valid?' },
      { id: 'queue', type: 'rectangle', x: 800, y: 0, width: 300, label: 'Queue' },
    ],
  })
  assert(!result.isError, text(result))
  assertEquals(result.structuredContent, { path: PATH, version: 1, added: 10, element_count: 10 })
  const elements = elementsOf(files[PATH].content)
  // Each shape, then its label right after it.
  assertEquals(elements.map((element) => element.id), ['api', 'api-label', 'auth', 'auth-label', 'db', 'db-label', 'valid', 'valid-label', 'queue', 'queue-label'])
  const byId = new Map(elements.map((element) => [element.id, element]))
  const size = (id: string) => [byId.get(id)!.width, byId.get(id)!.height]
  // At least 140 by 70; a long label (estimated 242 wide) gets 20 px each side.
  assertEquals(size('api'), [140, 70])
  assertEquals(size('auth'), [282, 70])
  // The largest box inside an ellipse is 1/√2 of it, inside a diamond half: 'Database' is 88 by 25, 'Valid?' 66 by 25.
  assertEquals(size('db'), [182, 70])
  assertEquals(size('valid'), [212, 90])
  // A width it was sent stays, and only the height is fitted.
  assertEquals(size('queue'), [300, 70])
  for (const id of ['api', 'auth', 'db', 'valid', 'queue']) {
    const [shape, label] = [byId.get(id)!, byId.get(`${id}-label`)!]
    assertEquals(shape.boundElements, [{ type: 'text', id: `${id}-label` }])
    assertEquals([label.type, label.containerId, label.textAlign, label.verticalAlign, label.fontFamily, label.fontSize], ['text', id, 'center', 'middle', 5, 20])
    assertEquals(middleOf(label), middleOf(shape), `${id}'s label is centred`)
  }
  // A labelled shape is the shape and a text bound to it, as a call could send them.
  assertEquals(
    addSteady(null, [{ id: 'api', type: 'rectangle', x: 0, y: 0, label: 'API', strokeColor: '#1971c2' }]),
    addSteady(null, [
      { id: 'api', type: 'rectangle', x: 0, y: 0, width: 140, height: 70, strokeColor: '#1971c2' },
      { id: 'api-label', type: 'text', x: 0, y: 0, text: 'API', containerId: 'api' },
    ])
  )

  const drawn = drawingSvg(parseDrawing(files[PATH].content))
  assert('svg' in drawn)
  for (const words of ['API', 'Authentication service', 'Database', 'Valid?', 'Queue']) assertStringIncludes(drawn.svg, `>${words}</text>`)
})

Deno.test('an arrow sent with from and to runs between two boxes side by side, 8 px off their facing edges, bound to both', async () => {
  // 'browser' is in the drawing, 180 by 80 at 0, 0; 'cache' comes in the same call, after the arrow that names it.
  const { supabase, files } = project({ [PATH]: { content: BEFORE, version: 7 } })
  const result = await draw(supabase, {
    elements: [
      { id: 'browser-to-cache', type: 'arrow', from: 'browser', to: 'cache' },
      { id: 'cache', type: 'rectangle', x: 400, y: 0, width: 160, height: 80 },
      // Below it, so one arrow runs down; the x and y it was sent give way.
      { id: 'store', type: 'rectangle', x: 400, y: 200, width: 160, height: 80 },
      { id: 'cache-to-store', type: 'arrow', x: 999, y: 999, from: 'cache', to: 'store' },
    ],
  })
  assert(!result.isError, text(result))
  assertEquals(result.structuredContent, { path: PATH, version: 8, added: 4, element_count: 6 })
  const byId = new Map(elementsOf(files[PATH].content).map((element) => [element.id, element]))
  const across = byId.get('browser-to-cache')!
  const down = byId.get('cache-to-store')!
  // browser's right edge is at 180 and cache's left at 400; both middles are at y 40.
  assertEquals([across.x, across.y, across.points, across.width, across.height], [188, 40, [[0, 0], [204, 0]], 204, 0])
  assertEquals(endsOf(across), [[188, 40], [392, 40]])
  // cache's bottom edge is at 80 and store's top at 200.
  assertEquals(endsOf(down), [[480, 88], [480, 192]])
  assertEquals([across.startBinding, across.endBinding], [{ focus: 0, gap: 8, elementId: 'browser' }, { focus: 0, gap: 8, elementId: 'cache' }])
  assertEquals([down.startBinding, down.endBinding], [{ focus: 0, gap: 8, elementId: 'cache' }, { focus: 0, gap: 8, elementId: 'store' }])
  assertEquals([across.endArrowhead, across.startArrowhead, across.elbowed], ['arrow', null, false])
  // Each shape lists the arrows bound to it, and the arrow keeps its place in the call.
  assertEquals(byId.get('browser')!.boundElements, [{ type: 'text', id: 'old-label' }, { type: 'arrow', id: 'browser-to-cache' }])
  assertEquals(byId.get('cache')!.boundElements, [{ type: 'arrow', id: 'browser-to-cache' }, { type: 'arrow', id: 'cache-to-store' }])
  assertEquals(byId.get('store')!.boundElements, [{ type: 'arrow', id: 'cache-to-store' }])
  assertEquals(elementsOf(files[PATH].content).map((element) => element.id).slice(3), ['browser-to-cache', 'cache', 'store', 'cache-to-store'])

  // The arrow is the one a call could send with those points and bindings.
  const box = { id: 'cache', type: 'rectangle', x: 400, y: 0, width: 160, height: 80 }
  assertEquals(
    addSteady(BEFORE, [box, { id: 'link', type: 'arrow', from: 'browser', to: 'cache' }]),
    addSteady(BEFORE, [box, { id: 'link', type: 'arrow', x: 188, y: 40, points: [[0, 0], [204, 0]], startBinding: { elementId: 'browser' }, endBinding: { elementId: 'cache' } }])
  )

  const drawn = drawingSvg(parseDrawing(files[PATH].content))
  assert('svg' in drawn)
  const types = new Map([...byId.values()].map((element) => [element.id, element.type]))
  for (const arrow of [across, down]) assert(drawElement(arrow, types), `${arrow.id} draws nothing`)
})

Deno.test("an arrow's ends land 8 px outside an ellipse's, a diamond's and a turned box's outline, within a pixel", () => {
  const { content } = addElements(null, [
    { id: 'db', type: 'ellipse', x: 0, y: 0, width: 200, height: 100 },
    { id: 'check', type: 'diamond', x: 400, y: 300, width: 160, height: 120 },
    // A square turned 45°, level with the diamond's middle: a corner faces it, 50√2 from the square's middle.
    { id: 'turned', type: 'rectangle', x: 0, y: 310, width: 100, height: 100, angle: Math.PI / 4 },
    { id: 'db-to-check', type: 'arrow', from: 'db', to: 'check' },
    { id: 'check-to-turned', type: 'arrow', from: 'check', to: 'turned' },
  ] as NewElement[])
  const byId = new Map(elementsOf(content).map((element) => [element.id, element]))

  /** How far `point` is from the shape's outline, along the line from its middle: its outline measured as Excalidraw draws each shape. */
  const offOutline = (shape: Element, [px, py]: number[]) => {
    const [cx, cy] = middleOf(shape)
    const [a, b] = [(shape.width as number) / 2, (shape.height as number) / 2]
    const angle = (shape.angle as number) ?? 0
    // The point in the shape's own frame, turned back.
    const [lx, ly] = [(px - cx) * Math.cos(-angle) - (py - cy) * Math.sin(-angle), (px - cx) * Math.sin(-angle) + (py - cy) * Math.cos(-angle)]
    // 1 on the outline, more outside it.
    const scale = shape.type === 'ellipse'
      ? Math.hypot(lx / a, ly / b)
      : shape.type === 'diamond'
      ? Math.abs(lx) / a + Math.abs(ly) / b
      : Math.max(Math.abs(lx) / a, Math.abs(ly) / b)
    return Math.hypot(lx, ly) * (1 - 1 / scale)
  }
  for (const [arrowId, fromId, toId] of [['db-to-check', 'db', 'check'], ['check-to-turned', 'check', 'turned']]) {
    const [from, to, arrow] = [byId.get(fromId)!, byId.get(toId)!, byId.get(arrowId)!]
    const [start, end] = endsOf(arrow)
    // Each end is 8 px outside its shape, on the line between the two middles.
    assertAlmostEquals(offOutline(from, start), 8, 1, `${arrowId} starts 8 px off ${fromId}`)
    assertAlmostEquals(offOutline(to, end), 8, 1, `${arrowId} ends 8 px off ${toId}`)
    const [[sx, sy], [ex, ey]] = [middleOf(from), middleOf(to)]
    for (const [x, y] of [start, end]) assertAlmostEquals((ex - sx) * (y - sy) - (ey - sy) * (x - sx), 0, Math.hypot(ex - sx, ey - sy), `${arrowId} on the middles' line`)
  }
  // The turned square's corner faces the diamond: the arrow ends 8 px past the corner, not 8 px past where its edge was before it turned.
  const [, end] = endsOf(byId.get('check-to-turned')!)
  assertAlmostEquals(end[0], 50 + 50 * Math.SQRT2 + 8, 0.01)
  assertAlmostEquals(end[1], 360, 0.01)
})

Deno.test("an arrow's label sits on the middle of the arrow", async () => {
  const { supabase, files } = project({})
  const result = await draw(supabase, {
    elements: [
      { id: 'api', type: 'rectangle', x: 0, y: 0, label: 'API' },
      { id: 'db', type: 'ellipse', x: 300, y: 150, label: 'Database' },
      { id: 'api-to-db', type: 'arrow', from: 'api', to: 'db', label: 'SQL' },
      // The full form takes a label too.
      { id: 'note-link', type: 'arrow', x: 0, y: 300, points: [[0, 0], [200, 100]], label: 'later' },
    ],
  })
  assert(!result.isError, text(result))
  assertEquals(result.structuredContent, { path: PATH, version: 1, added: 8, element_count: 8 })
  const elements = elementsOf(files[PATH].content)
  assertEquals(elements.map((element) => element.id), ['api', 'api-label', 'db', 'db-label', 'api-to-db', 'api-to-db-label', 'note-link', 'note-link-label'])
  const byId = new Map(elements.map((element) => [element.id, element]))
  for (const id of ['api-to-db', 'note-link']) {
    const [arrow, label] = [byId.get(id)!, byId.get(`${id}-label`)!]
    const [[sx, sy], [ex, ey]] = endsOf(arrow)
    assertEquals(arrow.boundElements, [{ type: 'text', id: `${id}-label` }])
    assertEquals(label.containerId, id)
    const [mx, my] = middleOf(label)
    assertAlmostEquals(mx, (sx + ex) / 2, 0.01)
    assertAlmostEquals(my, (sy + ey) / 2, 0.01)
  }
  // The server draws the label with the backing that hides the arrow behind it.
  const drawn = drawingSvg(parseDrawing(files[PATH].content))
  assert('svg' in drawn)
  assertStringIncludes(drawn.svg, '>SQL</text>')
  assertStringIncludes(drawn.svg, 'class="label-bg"')
})

Deno.test('the full form adds exactly what it added before labels and from and to', () => {
  // Captured from draw at 36a641b with Math.random at 0.25 and `updated` fixed.
  const seed = 536870912
  const made = (fields: Element): Element => ({
    id: '', type: '', x: 0, y: 0, width: 0, height: 0, angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid',
    strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, index: '', roundness: null, seed, version: 1,
    versionNonce: seed, isDeleted: false, boundElements: [], updated: 1_700_000_000_000, link: null, locked: false, ...fields,
  })
  const words = (text: string, containerId: string | null, fontSize = 20) => ({
    text, fontSize, fontFamily: 5, textAlign: containerId ? 'center' : 'left', verticalAlign: containerId ? 'middle' : 'top', containerId,
    originalText: text, autoResize: true, lineHeight: 1.25,
  })
  const { content, added } = addSteady(null, [
    { id: 'client', type: 'rectangle', x: 0, y: 0, width: 180, height: 80, backgroundColor: '#a5d8ff', roundness: { type: 3 } },
    { id: 'client-label', type: 'text', x: 0, y: 0, text: 'Client', containerId: 'client' },
    { id: 'store', type: 'ellipse', x: 320, y: 0, width: 160, height: 80, strokeStyle: 'dashed' },
    { id: 'save', type: 'arrow', x: 188, y: 40, points: [[0, 0], [124, 0]], startBinding: { elementId: 'client' }, endBinding: { elementId: 'store', focus: 0.2, gap: 4 } },
    { id: 'save-label', type: 'text', x: 0, y: 0, text: 'save', containerId: 'save' },
    { id: 'rule', type: 'line', x: 0, y: 140, width: 480, height: 0 },
    { id: 'scribble', type: 'freedraw', x: 500, y: 0, points: [[0, 0], [10, 5], [20, 0]] },
    { id: 'note', type: 'text', x: 0, y: 160, text: 'Two lines\nof text', fontSize: 16 },
  ])
  assertEquals(added, 8)
  const elements = [
    made({
      id: 'client', type: 'rectangle', width: 180, height: 80, backgroundColor: '#a5d8ff', index: 'a0', roundness: { type: 3 },
      boundElements: [{ type: 'text', id: 'client-label' }, { type: 'arrow', id: 'save' }],
    }),
    made({ id: 'client-label', type: 'text', x: 57, y: 27.5, width: 66, height: 25, index: 'a1', ...words('Client', 'client') }),
    made({ id: 'store', type: 'ellipse', x: 320, width: 160, height: 80, strokeStyle: 'dashed', index: 'a2', boundElements: [{ type: 'arrow', id: 'save' }] }),
    made({
      id: 'save', type: 'arrow', x: 188, y: 40, width: 124, index: 'a3', boundElements: [{ type: 'text', id: 'save-label' }], points: [[0, 0], [124, 0]],
      lastCommittedPoint: null, startBinding: { focus: 0, gap: 8, elementId: 'client' }, endBinding: { focus: 0.2, gap: 4, elementId: 'store' },
      startArrowhead: null, endArrowhead: 'arrow', elbowed: false,
    }),
    made({ id: 'save-label', type: 'text', x: 228, y: 27.5, width: 44, height: 25, index: 'a4', ...words('save', 'save') }),
    made({
      id: 'rule', type: 'line', y: 140, width: 480, index: 'a5', points: [[0, 0], [480, 0]], lastCommittedPoint: null, startBinding: null,
      endBinding: null, startArrowhead: null, endArrowhead: null,
    }),
    made({
      id: 'scribble', type: 'freedraw', x: 500, width: 20, height: 5, index: 'a6', points: [[0, 0], [10, 5], [20, 0]], pressures: [],
      simulatePressure: true, lastCommittedPoint: null,
    }),
    made({ id: 'note', type: 'text', y: 160, width: 79.2, height: 40, index: 'a7', ...words('Two lines\nof text', null, 16) }),
  ]
  // The whole file, field order included.
  assertEquals(content, JSON.stringify({ type: 'excalidraw', version: 2, elements, appState: { viewBackgroundColor: '#ffffff' }, files: {} }, null, 2))
})
