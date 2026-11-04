import { expect, test } from 'bun:test'
import { SharedResourcePixels, type ResourceSnapshot } from './resourcePixels'

const target = (path: string, identity = path) => ({path, identity})

test('a later drawing keeps ready siblings and shares a pending render across arrivals', async () => {
  const cache = new SharedResourcePixels()
  const first = target('first.excalidraw')
  const second = target('second.excalidraw')
  const pending = Promise.withResolvers<string>()
  const calls: string[] = []
  const seen: ResourceSnapshot[] = []
  const render = async ({path}: {path: string}) => {calls.push(path); return path === first.path ? '<svg>first</svg>' : pending.promise}
  const initial = new AbortController()
  await cache.prepare([first], initial.signal, render, snapshot => seen.push(snapshot))
  initial.abort()
  const adding = new AbortController()
  const updated = cache.prepare([first, second], adding.signal, render, snapshot => seen.push(snapshot))
  expect(seen.at(-1)?.pixels[first.path]).toBe('<svg>first</svg>')
  adding.abort()
  const final = new AbortController()
  const continued = cache.prepare([first, second], final.signal, render, snapshot => seen.push(snapshot))
  pending.resolve('<svg>second</svg>')
  await Promise.all([updated, continued])
  expect(calls).toEqual([first.path, second.path])
  expect(seen.every(snapshot => snapshot.pixels[first.path] === '<svg>first</svg>' || Object.keys(snapshot.pixels).length === 0)).toBe(true)
  expect(seen.at(-1)?.pixels).toEqual({[first.path]: '<svg>first</svg>', [second.path]: '<svg>second</svg>'})
})

test('a fast later drawing cannot erase a previously ready drawing', async () => {
  const cache = new SharedResourcePixels()
  const first = target('first.excalidraw')
  const second = target('second.excalidraw')
  const seen: ResourceSnapshot[] = []
  let firstCalls = 0
  const render = async ({path}: {path: string}) => {if (path === first.path) firstCalls++; return `<svg>${path}</svg>`}
  await cache.prepare([first], new AbortController().signal, render, () => {})
  await cache.prepare([first, second], new AbortController().signal, render, snapshot => seen.push(snapshot))
  expect(firstCalls).toBe(1)
  expect(seen.every(snapshot => snapshot.pixels[first.path] === `<svg>${first.path}</svg>`)).toBe(true)
})

test('changing one diagram companion invalidates that diagram and ignores its late old render', async () => {
  const cache = new SharedResourcePixels()
  const old = target('flow.d2', 'source + missing companion')
  const updated = target('flow.d2', 'source + saved companion')
  const sibling = target('ready.excalidraw')
  const late = Promise.withResolvers<string>()
  const oldController = new AbortController()
  const seen: ResourceSnapshot[] = []
  const render = async (value: {path: string; identity: string}) => value.identity === old.identity ? late.promise : `<svg>${value.identity}</svg>`
  await cache.prepare([sibling], new AbortController().signal, render, () => {})
  const original = cache.prepare([old, sibling], oldController.signal, render, snapshot => seen.push(snapshot))
  oldController.abort()
  await cache.prepare([updated, sibling], new AbortController().signal, render, snapshot => seen.push(snapshot))
  const count = seen.length
  late.resolve('<svg>stale</svg>')
  await original
  expect(seen).toHaveLength(count)
  expect(cache.snapshot([updated, sibling]).pixels).toEqual({[updated.path]: `<svg>${updated.identity}</svg>`, [sibling.path]: `<svg>${sibling.identity}</svg>`})
  expect(seen.every(snapshot => snapshot.pixels[sibling.path] === `<svg>${sibling.identity}</svg>`)).toBe(true)
})

test('closing a view prevents late publication and a failed drawing stays local', async () => {
  const cache = new SharedResourcePixels()
  const good = target('good.excalidraw')
  const bad = target('bad.excalidraw')
  const late = Promise.withResolvers<string>()
  const controller = new AbortController()
  const seen: ResourceSnapshot[] = []
  const work = cache.prepare([good, bad], controller.signal, async value => {
    if (value.path === bad.path) throw new Error('Invalid drawing')
    return late.promise
  }, snapshot => seen.push(snapshot))
  controller.abort()
  const count = seen.length
  late.resolve('<svg>good</svg>')
  await work
  expect(seen).toHaveLength(count)
  await cache.prepare([good, bad], new AbortController().signal, async () => {throw new Error('Must reuse settled source')}, snapshot => seen.push(snapshot))
  expect(seen.at(-1)?.pixels[good.path]).toBe('<svg>good</svg>')
  expect(seen.at(-1)?.errors).toEqual([bad.path])
})
