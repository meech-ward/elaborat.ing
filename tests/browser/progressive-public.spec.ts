import {createServer, type Server} from 'node:http'
import {recordReadiness} from './readiness.ts'
import {expect, test, type Page, type Route} from './fixtures.ts'
import {fakeSupabase, SUPABASE} from './fake-supabase.ts'
import {APP_URL} from './urls.ts'
import type {SharedBundle} from '../../src/features/file-sharing/publicRemote.ts'

const TOKEN = 'cd'.repeat(32)
const SHARE = 'a0000000-0000-4000-8000-000000000002'
const FILE = 'f0000000-0000-4000-8000-000000000002'
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY6kAAAAASUVORK5CYII='
const CORS = {'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS'}
const frame = (page: Page) => page.frameLocator('iframe[title="Isolated document preview"]').first()
const gate = () => {let release!: () => void; const promise = new Promise<void>(resolve => {release = resolve}); return {promise, release}}

function manifest(): SharedBundle {
  return {share: {id: SHARE, file_id: FILE, path: 'guide.mdx', version: 1, revision: 1, archived: false},
    files: [{id: FILE, path: 'guide.mdx', version: 1, content: '# Read immediately\n\nText before independent assets.\n\n![Slow](slow.png)\n\n![Ready](ready.png)\n\n<Document src="child.mdx" title="Deferred child" defaultCollapsed={true} />'},
      {id: 'f0000000-0000-4000-8000-000000000003', path: 'slow.png', content: '', version: 1},
      {id: 'f0000000-0000-4000-8000-000000000004', path: 'ready.png', content: '', version: 1},
      {id: 'f0000000-0000-4000-8000-000000000005', path: 'child.mdx', content: '# Child\n\n![Deferred](deferred.png)', version: 1},
      {id: 'f0000000-0000-4000-8000-000000000006', path: 'deferred.png', content: '', version: 1}],
    pendingImages: [{path: 'slow.png', width: 1, height: 1}, {path: 'ready.png', width: 1, height: 1}, {path: 'deferred.png', width: 1, height: 1}], images: []}
}

async function setup(page: Page) {
  await fakeSupabase(page)
  const slow = gate()
  const state = {bundle: manifest(), revoked: false, calls: [] as Record<string, unknown>[], failed: new Set<number>()}
  const json = (route: Route, value: unknown, status = 200) => route.fulfill({status, headers: CORS, contentType: 'application/json', body: JSON.stringify(value)})
  await page.route(`${SUPABASE}/functions/v1/file-share`, async route => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({status: 204, headers: CORS})
    const body = route.request().postDataJSON() as Record<string, unknown>
    state.calls.push(body)
    if (state.revoked) return json(route, {error: 'Unavailable'}, 404)
    if (body.mode === 'image') {
      const index = Number(body.image)
      if (index === 0) await slow.promise
      if (state.revoked) return json(route, {error: 'Unavailable'}, 404)
      if (state.failed.has(index)) return json(route, {error: 'Invalid image'}, 409)
      const descriptor = state.bundle.pendingImages![index]
      return json(route, {share: state.bundle.share, image: {...descriptor, dataURL: PNG, preview: {dataURL: PNG, width: 1, height: 1}}})
    }
    if (body.known && (body.known as {revision: number}).revision === state.bundle.share.revision)
      return json(route, {unchanged: true, share: state.bundle.share})
    return json(route, state.bundle)
  })
  await page.route(`${SUPABASE}/rest/v1/rpc/list_file_share_comments`, route => route.request().method() === 'OPTIONS'
    ? route.fulfill({status: 204, headers: CORS}) : json(route, {share_id: SHARE, file_id: FILE, file_version: 1,
      archived: false, can_moderate: false, threads: []}))
  return {state, slow}
}

for (const failed of [false, true]) test(`public text and ready image appear while another image is ${failed ? 'failing' : 'blocked'}`, async ({page}, testInfo) => {
  const {state, slow} = await setup(page)
  if (failed) state.failed.add(0)
  const started = Date.now()
  await page.goto(new URL(`s/${TOKEN}`, APP_URL).href)
  await expect(frame(page).getByRole('heading', {name: 'Read immediately'})).toBeVisible()
  const readableMs = Date.now() - started
  await recordReadiness(page, testInfo, 'public-readable-root')
  await expect(frame(page).getByRole('img', {name: 'Ready', exact: true})).toHaveAttribute('src', PNG)
  await recordReadiness(page, testInfo, 'public-first-ready-asset')
  await expect(frame(page).getByRole('img', {name: 'Slow', exact: true})).not.toHaveAttribute('src', PNG)
  expect(state.calls.filter(call => call.mode === 'image').map(call => call.image)).toEqual(expect.arrayContaining([0, 1]))
  expect(state.calls.some(call => call.image === 2)).toBe(false)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect.poll(() => state.calls.some(call => call.mode === 'manifest' && call.known)).toBe(true)
  await expect(frame(page).getByRole('heading', {name: 'Read immediately'})).toBeVisible()
  slow.release()
  if (failed) {
    await expect(frame(page).getByRole('img', {name: 'Slow', exact: true})).not.toHaveAttribute('src', PNG)
    await expect(frame(page).getByRole('img', {name: 'Ready', exact: true})).toHaveAttribute('src', PNG)
  }
  else await expect(frame(page).getByRole('img', {name: 'Slow', exact: true})).toHaveAttribute('src', PNG)
  await recordReadiness(page, testInfo, 'public-visible-assets-settled')
  await testInfo.attach('public-readiness.json', {contentType: 'application/json', body: JSON.stringify({readableMs, allVisibleAssetsMs: Date.now() - started, collapsedImageRequested: state.calls.some(call => call.image === 2)})})
})

test('revocation refresh removes a healthy public reader while an image remains blocked', async ({page, appErrors}) => {
  appErrors.expect('This link is unavailable.')
  const {state, slow} = await setup(page)
  await page.goto(new URL(`s/${TOKEN}`, APP_URL).href)
  await expect(frame(page).getByRole('heading', {name: 'Read immediately'})).toBeVisible()
  state.revoked = true
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByRole('heading', {name: 'Shared file unavailable'})).toBeVisible()
  slow.release()
  await expect(page.locator('iframe[title="Isolated document preview"]')).toHaveCount(0)
})

test('a later revision discards old image work without replacing the new source', async ({page}) => {
  const {state, slow} = await setup(page)
  await page.goto(new URL(`s/${TOKEN}`, APP_URL).href)
  await expect(frame(page).getByRole('heading', {name: 'Read immediately'})).toBeVisible()
  state.bundle = {...state.bundle, share: {...state.bundle.share, revision: 2, version: 2},
    files: [{...state.bundle.files[0], version: 2, content: '# New saved revision'}, ...state.bundle.files.slice(1)]}
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(frame(page).getByRole('heading', {name: 'New saved revision'})).toBeVisible()
  slow.release()
  await expect(frame(page).getByRole('heading', {name: 'New saved revision'})).toBeVisible()
  await expect(frame(page).getByRole('heading', {name: 'Read immediately'})).toHaveCount(0)
})


const streamServers = new Set<Server>()
test.afterEach(async () => {
  await Promise.all([...streamServers].map(server => new Promise<void>(resolve => {
    server.closeAllConnections(); server.close(() => resolve()); streamServers.delete(server)
  })))
})

async function streamingSetup(page: Page, missingChild = false, pendingComponent = false) {
  await fakeSupabase(page)
  const child = gate(), slow = gate(), unchanged = gate()
  const shared = manifest()
  if (pendingComponent) shared.files[0] = {...shared.files[0], content: `import {Late} from 'workspace:components/late.mdx'\n\n${shared.files[0].content}\n\n<Late />`}
  const state = {revoked: false, calls: [] as Record<string, unknown>[], canceled: 0, holdUnchanged: false, failStream: false}
  const server = createServer(async (request, response) => {
    for (const [key, value] of Object.entries(CORS)) response.setHeader(key, value)
    if (request.method === 'OPTIONS') {response.writeHead(204); response.end(); return}
    let raw = ''
    for await (const chunk of request) raw += String(chunk)
    const body = JSON.parse(raw) as Record<string, unknown>
    state.calls.push(body)
    const json = (value: unknown, status = 200) => {response.writeHead(status, {'content-type': 'application/json'}); response.end(JSON.stringify(value))}
    if (state.revoked) {json({error: 'Unavailable'}, 404); return}
    if (body.known) {if (state.holdUnchanged) await unchanged.promise; json({unchanged: true, share: shared.share}); return}
    if (!body.mode) {
      await Promise.all([child.promise, slow.promise])
      if (missingChild) {json({error: 'Missing child'}, 409); return}
      json({...shared, images: shared.pendingImages!.map(descriptor => ({...descriptor, dataURL: PNG, preview: {dataURL: PNG, width: 1, height: 1}}))})
      return
    }
    response.writeHead(200, {'content-type': 'application/x-ndjson', 'cache-control': 'no-store'})
    response.on('close', () => {if (!response.writableEnded) state.canceled++})
    const write = (event: unknown) => {if (!response.destroyed && !response.writableEnded) response.write(JSON.stringify(event) + '\n')}
    write({type: 'start', share: shared.share})
    write({type: 'file', file: shared.files[0], pendingPaths: ['slow.png', 'ready.png', 'child.mdx', ...(pendingComponent ? ['components/late.mdx'] : [])], pendingImages: []})
    for (const index of [1, 2]) write({type: 'file', file: shared.files[index], pendingPaths: [], pendingImages: [shared.pendingImages![index - 1]]})
    write({type: 'image', image: {...shared.pendingImages![1], dataURL: PNG, preview: {dataURL: PNG, width: 1, height: 1}}})
    await Promise.all([
      child.promise.then(() => {
        if (pendingComponent) write({type: 'file', file: {id: 'f0000000-0000-4000-8000-000000000007', path: 'components/late.mdx', version: 1, content: 'export const Late = () => <span>Late component ready</span>'}, pendingPaths: [], pendingImages: []})
        if (missingChild) write({type: 'file-error', path: 'child.mdx'})
        else {
          write({type: 'file', file: shared.files[3], pendingPaths: ['deferred.png'], pendingImages: []})
          write({type: 'file', file: shared.files[4], pendingPaths: [], pendingImages: [shared.pendingImages![2]]})
          write({type: 'image', image: {...shared.pendingImages![2], dataURL: PNG, preview: {dataURL: PNG, width: 1, height: 1}}})
        }
      }),
      slow.promise.then(() => write({type: 'image', image: {...shared.pendingImages![0], dataURL: PNG, preview: {dataURL: PNG, width: 1, height: 1}}})),
    ])
    if (!response.destroyed) {write(state.failStream ? {type: 'error', status: 502, error: 'Stream failed'} : {type: 'complete'}); response.end()}
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  streamServers.add(server)
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('The stream fixture could not start.')
  await page.addInitScript(({endpoint, original}) => {
    const fetch = window.fetch.bind(window)
    window.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => fetch(typeof input === 'string' && input === original ? endpoint : input, init), window.fetch)
  }, {endpoint: `http://127.0.0.1:${address.port}`, original: `${SUPABASE}/functions/v1/file-share`})
  await page.route(`${SUPABASE}/rest/v1/rpc/list_file_share_comments`, route => route.request().method() === 'OPTIONS'
    ? route.fulfill({status: 204, headers: CORS}) : route.fulfill({status: 200, headers: CORS, contentType: 'application/json',
      body: JSON.stringify({share_id: SHARE, file_id: FILE, file_version: 1, archived: false, can_moderate: false, threads: []})}))
  return {state, child, slow, unchanged}
}

for (const missing of [false, true]) test(`streamed public root remains readable before ${missing ? 'a missing' : 'a delayed'} child source`, async ({page}, testInfo) => {
  const {state, child, slow} = await streamingSetup(page, missing)
  const started = Date.now()
  await page.goto(new URL(`s/${TOKEN}`, APP_URL).href)
  await expect(frame(page).getByRole('heading', {name: 'Read immediately'})).toBeVisible()
  const readableMs = Date.now() - started
  await recordReadiness(page, testInfo, 'public-readable-root')
  await expect(frame(page).getByRole('img', {name: 'Ready', exact: true})).toHaveAttribute('src', PNG)
  await recordReadiness(page, testInfo, 'public-first-ready-asset')
  await expect(frame(page).getByRole('img', {name: 'Slow', exact: true})).not.toHaveAttribute('src', PNG)
  await expect(frame(page).locator('iframe')).toHaveCount(0)
  // Revalidation must neither wait for nor cancel an incomplete stream.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect.poll(() => state.calls.some(call => Boolean(call.known))).toBe(true)
  expect(state.canceled).toBe(0)
  child.release()
  await expect(frame(page).getByRole('heading', {name: 'Read immediately'})).toBeVisible()
  slow.release()
  await expect(frame(page).getByRole('img', {name: 'Slow', exact: true})).toHaveAttribute('src', PNG)
  await expect(frame(page).locator('iframe')).toHaveCount(0)
  await recordReadiness(page, testInfo, 'public-stream-assets-settled')
  await testInfo.attach('stream-readiness.json', {contentType: 'application/json', body: JSON.stringify({readableMs, allVisibleAssetsMs: Date.now() - started})})
})


test('streamed public prose stays readable and selected while an imported component source is blocked', async ({page}, testInfo) => {
  const {child, slow} = await streamingSetup(page, false, true)
  await page.goto(new URL(`s/${TOKEN}`, APP_URL).href)
  await expect(frame(page).getByRole('heading', {name: 'Read immediately'})).toBeVisible()
  await recordReadiness(page, testInfo, 'public-before-component-source')
  await expect(frame(page).getByRole('img', {name: 'Ready', exact: true})).toHaveAttribute('src', PNG)
  const paragraph = frame(page).getByText('Text before independent assets.', {exact: true})
  await paragraph.evaluate(node => {
    const range = node.ownerDocument.createRange()
    range.selectNodeContents(node)
    const selection = node.ownerDocument.getSelection()!
    selection.removeAllRanges(); selection.addRange(range)
  })
  child.release()
  await expect(frame(page).getByText('Late component ready', {exact: true})).toBeVisible()
  expect(await paragraph.evaluate(node => node.ownerDocument.getSelection()?.toString())).toBe('Text before independent assets.')
  await recordReadiness(page, testInfo, 'public-after-component-source')
  slow.release()
})


test('a delayed unchanged check cannot clear an error after its partial stream fails', async ({page, appErrors}) => {
  appErrors.expect('The shared file could not load. Try again.')
  const {state, child, slow, unchanged} = await streamingSetup(page)
  await page.goto(new URL(`s/${TOKEN}`, APP_URL).href)
  await expect(frame(page).getByRole('heading', {name: 'Read immediately'})).toBeVisible()
  state.holdUnchanged = true
  const checksBefore = state.calls.filter(call => Boolean(call.known)).length
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect.poll(() => state.calls.filter(call => Boolean(call.known)).length).toBeGreaterThan(checksBefore)
  state.failStream = true
  child.release(); slow.release()
  await expect(page.getByRole('heading', {name: 'Shared file unavailable'})).toBeVisible()
  const checked = page.waitForResponse(response => response.request().method() === 'POST' && Boolean((response.request().postDataJSON() as Record<string, unknown>)?.known))
  unchanged.release()
  await (await checked).finished()
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  await expect(page.getByRole('heading', {name: 'Shared file unavailable'})).toBeVisible()
  await expect(page.getByRole('button', {name: 'Try again', exact: true})).toBeVisible()
  await expect(page.locator('iframe[title="Isolated document preview"]')).toHaveCount(0)
})
