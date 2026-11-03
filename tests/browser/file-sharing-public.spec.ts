import AxeBuilder from './axe.ts'
import { expect, test, type Page, type Route } from './fixtures.ts'
import { fakeSupabase, person, signedIn, SUPABASE } from './fake-supabase.ts'
import { APP_URL } from './urls.ts'
import type { RemoteThread } from '../../src/features/comments/remote.ts'
import type { CommentAnchor } from '../../src/features/comments/placement.ts'
import type { SharedBundle } from '../../src/features/file-sharing/publicRemote.ts'

test.describe.configure({ timeout: 60_000 })
const TOKEN = 'ab'.repeat(32)
const SHARE = 'a0000000-0000-4000-8000-000000000001'
const FILE = 'f0000000-0000-4000-8000-000000000001'
const href = new URL(`s/${TOKEN}`, APP_URL).href
const FRAME = 'iframe[title="Isolated document preview"]'
const frame = (page: Page) => page.frameLocator(FRAME).first()
const panel = (page: Page) => page.getByRole('complementary', { name: 'Shared file comments' })
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY6kAAAAASUVORK5CYII='
const CORS = {'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS'}
const now = () => new Date().toISOString()
const author = () => ({user_id: person.id, email: null, name: 'Visitor'})

function bundle(content = '# Shared guide\n\nRead without an account.', path = 'guide.mdx'): SharedBundle {
  return {share: {id: SHARE, file_id: FILE, path, version: 7, revision: 7, archived: false},
    files: [{id: FILE, path, content, version: 7}], images: []}
}

async function setup(page: Page, options: {bundle?: SharedBundle; signedIn?: boolean; threads?: RemoteThread[]} = {}) {
  const fake = await fakeSupabase(page)
  if (options.signedIn) await signedIn(page)
  const state = {bundle: options.bundle ?? bundle(), threads: options.threads ?? [] as RemoteThread[], revoked: false,
    calls: [] as {name: string; args: Record<string, unknown>}[]}
  const json = (route: Route, value: unknown, status = 200) => route.fulfill({status, headers: CORS, contentType: 'application/json', body: JSON.stringify(value)})
  await page.route(`${SUPABASE}/functions/v1/file-share`, route => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({status: 204, headers: CORS})
    state.calls.push({name: 'read', args: route.request().postDataJSON() as Record<string, unknown>})
    return state.revoked ? json(route, {error: 'Shared file unavailable'}, 404) : json(route, state.bundle)
  })
  await page.route(`${SUPABASE}/rest/v1/rpc/*file_share*`, route => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({status: 204, headers: CORS})
    const name = new URL(route.request().url()).pathname.split('/').pop()!
    const args = route.request().postDataJSON() as Record<string, unknown>
    state.calls.push({name, args})
    if (state.revoked) return json(route, {code: '42501', message: 'Shared file unavailable'}, 403)
    if (name === 'list_file_share_comments') return json(route, {share_id: SHARE, file_id: FILE,
      file_version: state.bundle.share.version, archived: state.bundle.share.archived, can_moderate: false, threads: state.threads})
    const makeComment = () => ({id: String(args.comment_id), author: author(), via_agent: false, agent: null,
      body: String(args.body), created_at: now(), edited_at: null, deleted_at: null, file_version: null})
    if (name === 'add_file_share_comment') {
      const thread: RemoteThread = {id: String(args.thread_id), file_id: FILE, path: state.bundle.share.path,
        file_deleted: false, file_version: Number(args.file_version), anchor: args.anchor as CommentAnchor,
        created_at: now(), resolved_at: null, resolved_by: null, ask_agent: false, comments: [makeComment()]}
      state.threads.push(thread)
      return json(route, {thread})
    }
    const thread = state.threads.find(t => t.id === args.thread_id || t.comments.some(c => c.id === args.comment_id))
    if (!thread) return json(route, {code: '42501', message: 'Comment unavailable'}, 403)
    if (name === 'reply_file_share_comment') {const comment = makeComment(); thread.comments.push(comment); return json(route, {comment})}
    if (name === 'resolve_file_share_thread') {thread.resolved_at = args.resolved ? now() : null; thread.resolved_by = args.resolved ? author() : null; return json(route, {thread})}
    const comment = thread.comments.find(c => c.id === args.comment_id)!
    if (name === 'edit_file_share_comment') {comment.body = String(args.body); comment.edited_at = now(); return json(route, {comment})}
    if (name === 'delete_file_share_comment') {comment.body = null; comment.deleted_at = now(); return json(route, {comment})}
    return json(route, {error: `Unexpected RPC ${name}`}, 400)
  })
  return {state, fake}
}

test('anyone can read a complete long rendered file without project or source controls', async ({page}) => {
  const content = `# Shared guide\n\n${'A paragraph in the full shared document.\n\n'.repeat(650)}## End of the full file\n\nNothing was truncated.`
  const {state, fake} = await setup(page, {bundle: bundle(content, 'long.md')})
  await page.goto(href)
  await expect(frame(page).getByRole('heading', {name: 'Shared guide'})).toBeVisible({timeout: 20_000})
  await expect(frame(page).getByRole('heading', {name: 'End of the full file'})).toBeAttached()
  await expect(frame(page).getByText('Nothing was truncated.')).toBeAttached()
  await expect(page).toHaveURL(href)
  await expect(page.getByRole('button', {name: 'Source', exact: true})).toHaveCount(0)
  await expect(page.getByRole('navigation', {name: 'Workspace files'})).toHaveCount(0)
  await expect(page.locator('.monaco-editor')).toHaveCount(0)
  expect(state.calls.find(c => c.name === 'read')?.args).toEqual({token: TOKEN})
  expect(fake.requests.some(r => /project_files|list_projects|list_members|list_comments/.test(r.url()))).toBe(false)
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, nofollow, noarchive')
  await expect(page.locator('meta[name="referrer"]')).toHaveAttribute('content', 'no-referrer')
})

test('shared notes render local images, drawings, and collapsible embedded documents', async ({page}) => {
  const shared = bundle('# Shared guide\n\n![Shared pixel](photo.png)\n\n<Drawing src="board.excalidraw" />\n\n<Document src="child.md" title="Implementation details" defaultCollapsed />')
  shared.files.push({id: crypto.randomUUID(), path: 'child.md', content: '# Embedded details\n\nThis child remains a separate file.', version: 7},
    {id: crypto.randomUUID(), path: 'board.excalidraw', content: JSON.stringify({type: 'excalidraw', version: 2, elements: [
      {id: 'box', type: 'rectangle', x: 0, y: 0, width: 120, height: 60, angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent',
        fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, index: 'a0',
        roundness: null, seed: 1, version: 1, versionNonce: 1, isDeleted: false, boundElements: [], updated: 1, link: null, locked: false},
    ], appState: {}, files: {}}), version: 7})
  shared.images.push({path: 'photo.png', dataURL: PNG, width: 1, height: 1, preview: {dataURL: PNG, width: 1, height: 1}})
  await setup(page, {bundle: shared})
  await page.goto(href)
  await expect(frame(page).getByRole('img', {name: 'Shared pixel'})).toBeVisible({timeout: 20_000})
  await expect(frame(page).locator('figure[data-src="board.excalidraw"]')).toHaveAttribute('data-pixels', 'true')
  const details = frame(page).getByRole('button', {name: /Implementation details/}).first()
  await details.click()
  await expect(page.locator(FRAME)).toHaveCount(1)
  await expect.poll(async () => (await Promise.all(page.frames().map(f => f.getByRole('heading', {name: 'Embedded details'}).count()))).reduce((sum, count) => sum + count, 0)).toBeGreaterThan(0)
  await expect(page.locator('.monaco-editor')).toHaveCount(0)
  await details.click()
  await expect(details).toHaveAttribute('aria-expanded', 'false')
})

test('ordinary project links stay private and custom components ask before running', async ({page}) => {
  const shared = bundle('export const PublicBadge = () => <span>Custom shared badge</span>\n\n# Shared guide\n\n<PublicBadge />\n\n[Private planning](secret.md)')
  const {state} = await setup(page, {bundle: shared})
  await page.goto(href)
  await expect(page.getByRole('heading', {name: 'This file runs custom code'})).toBeVisible()
  await page.getByRole('button', {name: 'Run code', exact: true}).click()
  await expect(frame(page).getByText('Custom shared badge')).toBeVisible({timeout: 20_000})
  await frame(page).getByRole('link', {name: 'Private planning'}).click()
  await expect(page.getByText('That link points to another project file. It needs its own share link.')).toBeVisible()
  await expect(page).toHaveURL(href)
  expect(state.calls.filter(c => c.name === 'read').every(c => Object.keys(c.args).join() === 'token')).toBe(true)
})

test('an image file can be shared directly and still has its own comment discussion', async ({page}) => {
  const shared = bundle('', 'photo.png')
  shared.images.push({path: 'photo.png', dataURL: PNG, width: 1, height: 1, preview: {dataURL: PNG, width: 1, height: 1}})
  await setup(page, {bundle: shared})
  await page.goto(href)
  await expect(page.getByRole('img', {name: 'photo.png', exact: true})).toBeVisible()
  await expect(page.locator(FRAME)).toHaveCount(0)
  await page.getByRole('button', {name: 'Add comment', exact: true}).click()
  await expect(panel(page).getByRole('textbox', {name: 'New comment'})).toBeVisible()
})

const FORM_MODULE = `import {useState} from 'react'

export function FormDemo() {
  const [name, setName] = useState('')
  const [result, setResult] = useState('No greeting yet')
  const [attempted, setAttempted] = useState('No programmatic attempt')
  const submitNative = (id, request) => {
    try {
      const form = document.getElementById(id)
      if (request) form.requestSubmit()
      else form.submit()
    } catch {
      // Firefox may throw a nameless native CSP refusal. The browser test
      // requires a fresh form-action violation after every attempted call.
    }
    setAttempted(request ? 'requestSubmit attempted' : 'submit attempted')
  }
  return <div>
    <form onSubmit={event => {event.preventDefault(); setResult('Hello ' + name)}}>
      <label htmlFor="visitor-name">Your name</label>
      <input id="visitor-name" value={name} onChange={event => setName(event.target.value)} />
      <button type="submit">Show greeting</button>
    </form>
    <p role="status" aria-label="Greeting result">{result}</p>
    <form id="external-get" action="https://form-probe.example/get" method="get">
      <input type="hidden" name="payload" value="test-value" />
      <button type="submit">Unhandled GET</button>
    </form>
    <form id="external-post" action="https://form-probe.example/post" method="post">
      <input type="hidden" name="payload" value="test-value" />
      <button type="submit">Unhandled POST</button>
    </form>
    <button type="button" onClick={() => submitNative('external-post', false)}>Programmatic submit</button>
    <button type="button" onClick={() => submitNative('external-get', true)}>Programmatic requestSubmit</button>
    <p role="status" aria-label="Form submission attempt">{attempted}</p>
  </div>
}
`

async function sharedForm(page: Page) {
  const shared = bundle('import {FormDemo} from "workspace:forms/form-demo.mdx"\n\n# Interactive shared form\n\n<FormDemo />')
  shared.files.push({id: crypto.randomUUID(), path: 'forms/form-demo.mdx', content: FORM_MODULE, version: 7})
  const setupResult = await setup(page, {bundle: shared})
  await page.goto(href)
  await page.getByRole('button', {name: 'Run code', exact: true}).click()
  await expect(frame(page).getByLabel('Your name')).toBeVisible({timeout: 20_000})
  return setupResult
}

test('a native form in a shared custom component keeps local state and handles preventDefault submission', async ({page}) => {
  const {state, fake} = await sharedForm(page)
  const original = state.bundle.files.map(file => file.content)
  await frame(page).getByLabel('Your name').fill('Ada')
  await frame(page).getByRole('button', {name: 'Show greeting', exact: true}).click()
  await expect(frame(page).getByRole('status', {name: 'Greeting result'})).toHaveText('Hello Ada')
  await frame(page).getByLabel('Your name').fill('Grace')
  await frame(page).getByLabel('Your name').press('Enter')
  await expect(frame(page).getByRole('status', {name: 'Greeting result'})).toHaveText('Hello Grace')
  expect(state.bundle.files.map(file => file.content)).toEqual(original)
  expect(fake.requests.some(request => /save_files|save_file/.test(request.url()))).toBe(false)
  expect(state.calls.every(call => call.name === 'read' || call.name === 'list_file_share_comments')).toBe(true)
})

test('unhandled and programmatic native form submissions cannot send data or navigate the isolated shared view', async ({page}) => {
  const reached: string[] = []
  await page.route('https://form-probe.example/**', route => {
    reached.push(route.request().url())
    return route.fulfill({status: 200, contentType: 'text/html', body: '<h1>Form escaped</h1>'})
  })
  const {state, fake} = await sharedForm(page)
  const original = state.bundle.files.map(file => file.content)
  const initialFrameURL = await frame(page).locator('html').evaluate(() => location.href)
  await frame(page).locator('html').evaluate(() => {
    const state = window as unknown as {formViolations: string[]}
    state.formViolations = []
    document.addEventListener('securitypolicyviolation', event => {
      if (event.effectiveDirective === 'form-action') state.formViolations.push(event.blockedURI)
    })
  })
  let attempts = 0
  for (const name of ['Unhandled GET', 'Unhandled POST', 'Programmatic submit', 'Programmatic requestSubmit']) {
    await frame(page).getByRole('button', {name, exact: true}).click()
    await expect(frame(page).getByLabel('Your name')).toBeVisible()
    if (name === 'Programmatic submit') await expect(frame(page).getByRole('status', {name: 'Form submission attempt'})).toHaveText('submit attempted')
    if (name === 'Programmatic requestSubmit') await expect(frame(page).getByRole('status', {name: 'Form submission attempt'})).toHaveText('requestSubmit attempted')
    attempts++
    await expect.poll(() => frame(page).locator('html').evaluate(() =>
      (window as unknown as {formViolations: string[]}).formViolations.length)).toBe(attempts)
  }
  // A refused form navigation has no response to await. Give a wrongly
  // permitted navigation a turn to reach the intercepted external origin.
  await page.waitForTimeout(300)
  expect(reached).toEqual([])
  expect(await frame(page).locator('html').evaluate(() => location.href)).toBe(initialFrameURL)
  await expect(page).toHaveURL(href)
  await expect(frame(page).getByRole('status', {name: 'Greeting result'})).toHaveText('No greeting yet')
  expect(state.bundle.files.map(file => file.content)).toEqual(original)
  expect(fake.requests.some(request => /save_files|save_file/.test(request.url()))).toBe(false)
  expect(state.calls.every(call => call.name === 'read' || call.name === 'list_file_share_comments')).toBe(true)
})

test('a fixed-position modal in a long interactive shared note opens fully in the visible browser viewport', async ({page}) => {
  const content = `import {useState} from 'react'

export function DetailsModal() {
  const [open, setOpen] = useState(false)
  return <div>
    <button type="button" onClick={() => setOpen(true)}>Open details</button>
    {open ? <div role="dialog" aria-modal="true" aria-label="Form details" style={{position:'fixed',top:'50%',left:'50%',transform:'translate(-50%, -50%)',width:280,padding:24,background:'white',color:'black',border:'1px solid black',zIndex:1000}}>
      <h2>Form details</h2>
      <p>The modal belongs in the visible preview.</p>
      <button type="button" onClick={() => setOpen(false)}>Done</button>
    </div> : null}
  </div>
}

# Shared guide

<DetailsModal />

${'Read a paragraph in this long interactive document.\n\n'.repeat(65)}`
  await setup(page, {bundle: bundle(content)})
  await page.goto(href)
  await page.getByRole('button', {name: 'Run code', exact: true}).click()
  await frame(page).getByRole('button', {name: 'Open details', exact: true}).click()
  const modal = frame(page).getByRole('dialog', {name: 'Form details'})
  await expect(modal).toBeAttached()
  // Bounding boxes do not scroll controls into view, so this catches a fixed
  // modal centered thousands of pixels below the browser in a tall iframe.
  const box = (await modal.boundingBox())!
  const viewport = page.viewportSize()!
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height)
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
  await modal.getByRole('button', {name: 'Done', exact: true}).click()
  await expect(modal).toHaveCount(0)
})

test('posting asks for sign-in and returns with the selection, comment draft, and reading position', async ({page}) => {
  const shared = bundle(`# Shared guide\n\n${'Read this paragraph before reviewing the later section.\n\n'.repeat(45)}## Review this section\n\nFeedback belongs here.`)
  const {state, fake} = await setup(page, {bundle: shared})
  await page.goto(href)
  const heading = frame(page).getByRole('heading', {name: 'Review this section'})
  await heading.scrollIntoViewIfNeeded()
  await heading.hover()
  await page.getByRole('button', {name: 'Comment on section'}).click()
  await expect(panel(page).locator('blockquote')).toContainText('Review this section')
  await panel(page).getByRole('textbox', {name: 'New comment'}).fill('Keep my feedback through sign-in.')
  await expect(page).toHaveURL(href)
  const scroll = await page.evaluate(() => window.scrollY)
  expect(scroll).toBeGreaterThan(0)
  await panel(page).getByRole('button', {name: 'Sign in to post'}).click()
  await expect(page).toHaveURL(new URL(`sign-in?next=%2Fs%2F${TOKEN}`, APP_URL).href)
  await page.getByRole('button', {name: 'Use a password instead'}).click()
  await page.getByLabel('Email', {exact: true}).fill(person.email)
  await page.getByLabel('Password', {exact: true}).fill('a password')
  await page.getByRole('button', {name: 'Sign in', exact: true}).click()
  await expect(page).toHaveURL(href)
  await expect(panel(page).getByRole('textbox', {name: 'New comment'})).toHaveValue('Keep my feedback through sign-in.')
  await expect(panel(page).locator('blockquote')).toContainText('Review this section')
  await expect.poll(() => page.evaluate(() => window.scrollY), {timeout: 10_000}).toBeGreaterThan(0)
  await panel(page).getByRole('button', {name: 'Comment', exact: true}).click()
  await expect(panel(page).getByText('Keep my feedback through sign-in.', {exact: true})).toBeVisible()
  const posted = state.calls.find(c => c.name === 'add_file_share_comment')!
  expect(posted.args).toMatchObject({file_version: 7, body: 'Keep my feedback through sign-in.', anchor: {kind: 'section', quote: {exact: '## Review this section'}}})
  expect(fake.server.projects.size).toBe(0)
  expect(fake.requests.some(r => /accept_invitation|share_project/.test(r.url()))).toBe(false)
})

test('signing in from a long interactive note restores its internal reading position for a whole-file comment', async ({page}) => {
  const content = `export const LocalGreeting = () => <span>Interactive note</span>\n\n# Shared guide\n\n<LocalGreeting />\n\n${'A short paragraph to read before the later section.\n\n'.repeat(65)}## Return to this part\n\nRead from here after signing in.`
  const {state} = await setup(page, {bundle: bundle(content)})
  await page.goto(href)
  await page.getByRole('button', {name: 'Run code', exact: true}).click()
  await expect(frame(page).getByRole('heading', {name: 'Shared guide'})).toBeVisible({timeout: 20_000})
  await frame(page).getByRole('heading', {name: 'Return to this part'}).scrollIntoViewIfNeeded()
  const readPosition = await frame(page).locator('html').evaluate(() => window.scrollY)
  expect(readPosition).toBeGreaterThan(1000)
  await page.getByRole('button', {name: 'Add comment', exact: true}).click()
  await panel(page).getByRole('textbox', {name: 'New comment'}).fill('Feedback from this reading position.')
  await panel(page).getByRole('button', {name: 'Sign in to post'}).click()
  await expect(page).toHaveURL(new URL(`sign-in?next=%2Fs%2F${TOKEN}`, APP_URL).href)
  const sourceOffset = await page.evaluate(id => JSON.parse(sessionStorage.getItem(`elaborating.shared-comment.v1:${id}`)!).sourceOffset as number, SHARE)
  expect(sourceOffset).toBeGreaterThan(content.length / 2)
  await page.getByRole('button', {name: 'Use a password instead'}).click()
  await page.getByLabel('Email', {exact: true}).fill(person.email)
  await page.getByLabel('Password', {exact: true}).fill('a password')
  await page.getByRole('button', {name: 'Sign in', exact: true}).click()
  await expect(page).toHaveURL(href)
  await expect(panel(page).getByRole('textbox', {name: 'New comment'})).toHaveValue('Feedback from this reading position.')
  await expect.poll(() => frame(page).locator('html').evaluate(() => window.scrollY), {timeout: 15_000}).toBeGreaterThan(readPosition * 0.7)
  await panel(page).getByRole('button', {name: 'Comment', exact: true}).click()
  await expect(panel(page).getByText('Feedback from this reading position.', {exact: true})).toBeVisible()
  expect(state.calls.find(call => call.name === 'add_file_share_comment')?.args.anchor).toEqual({kind: 'document'})
})

test('signed-in visitors can post, reply, edit, resolve, reopen, and remove their own comment', async ({page}) => {
  const {state, fake} = await setup(page, {signedIn: true})
  await page.goto(href)
  await page.getByRole('button', {name: 'Add comment', exact: true}).click()
  await panel(page).getByRole('textbox', {name: 'New comment'}).fill('Initial feedback')
  await panel(page).getByRole('button', {name: 'Comment', exact: true}).click()
  const thread = panel(page).getByRole('article').first()
  await expect(thread.getByText('Initial feedback', {exact: true})).toBeVisible()
  await thread.getByRole('button', {name: 'Reply', exact: true}).click()
  await thread.getByRole('textbox', {name: 'Reply', exact: true}).fill('A useful reply')
  await thread.getByRole('button', {name: 'Reply', exact: true}).last().click()
  await expect(thread.getByText('A useful reply', {exact: true})).toBeVisible()
  await thread.getByRole('button', {name: 'Actions for the comment by Visitor'}).last().click()
  await page.getByRole('menuitem', {name: 'Edit', exact: true}).click()
  await thread.getByRole('textbox', {name: 'Edit comment'}).fill('A revised reply')
  await thread.getByRole('button', {name: 'Save', exact: true}).click()
  await expect(thread.getByText('A revised reply', {exact: true})).toBeVisible()
  await thread.getByRole('button', {name: 'Resolve', exact: true}).click()
  await panel(page).getByRole('button', {name: /Resolved/}).click()
  await panel(page).getByRole('button', {name: 'Reopen', exact: true}).click()
  await thread.getByRole('button', {name: 'Actions for the comment by Visitor'}).last().click()
  await page.getByRole('menuitem', {name: 'Delete', exact: true}).click()
  await page.getByRole('alertdialog').getByRole('button', {name: 'Delete', exact: true}).click()
  await expect(thread.getByText('Comment deleted', {exact: true})).toBeVisible()
  expect(new Set(state.calls.filter(c => c.name !== 'read').map(c => c.name))).toEqual(new Set([
    'list_file_share_comments','add_file_share_comment','reply_file_share_comment','edit_file_share_comment','resolve_file_share_thread','delete_file_share_comment',
  ]))
  expect(fake.server.projects.size).toBe(0)
})

test('revoking a link clears an already-open file on the next focus check', async ({page, appErrors}) => {
  appErrors.expect('This link is unavailable.')
  const {state} = await setup(page)
  await page.goto(href)
  await expect(frame(page).getByRole('heading', {name: 'Shared guide'})).toBeVisible({timeout: 20_000})
  state.revoked = true
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByRole('heading', {name: 'Shared file unavailable'})).toBeVisible()
  await expect(page.locator(FRAME)).toHaveCount(0)
  await expect(page.getByRole('button', {name: 'Add comment'})).toHaveCount(0)
})

test('an unavailable link explains itself and an archived file stays readable without comment actions', async ({page, appErrors}) => {
  appErrors.expect('This link is unavailable.')
  const {state} = await setup(page)
  state.revoked = true
  await page.goto(href)
  await expect(page.getByRole('heading', {name: 'Shared file unavailable'})).toBeVisible()
  state.revoked = false
  state.bundle.share.archived = true
  await page.getByRole('button', {name: 'Try again'}).click()
  await expect(frame(page).getByRole('heading', {name: 'Shared guide'})).toBeVisible({timeout: 20_000})
  await expect(page.getByText('This project is archived. Comments are read only.').first()).toBeVisible()
  await expect(page.getByRole('button', {name: 'Add comment'})).toHaveCount(0)
  await page.getByRole('button', {name: 'Comments', exact: true}).click()
  await expect(panel(page).getByRole('textbox')).toHaveCount(0)
})

for (const width of [390, 1280]) test(`the public file and comment draft fit at ${width}px and axe finds nothing`, async ({page}) => {
  await page.setViewportSize({width, height: 900})
  await setup(page)
  await page.goto(href)
  await expect(frame(page).getByRole('heading', {name: 'Shared guide'})).toBeVisible({timeout: 20_000})
  await page.getByRole('button', {name: 'Add comment', exact: true}).click()
  await expect(panel(page).getByRole('textbox', {name: 'New comment'})).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  const result = await new AxeBuilder({page}).analyze()
  expect(result.violations.map(v => ({id: v.id, targets: v.nodes.map(n => n.target)}))).toEqual([])
})
