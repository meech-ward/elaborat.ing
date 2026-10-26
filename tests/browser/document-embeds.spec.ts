import AxeBuilder from './axe.ts'
import { expect, test, type FrameLocator, type Page } from './fixtures.ts'
import { fakeSupabase, person, signedIn } from './fake-supabase.ts'
import { APP_URL } from './urls.ts'
import { showView } from './views.ts'

test.describe.configure({ timeout: 90_000 })

const ROOT = 'iframe[title="Isolated document preview"]:visible'
const PARENT = 'notes/parent.mdx'
const CHILD = 'notes/details.md'
const CHILD_TEXT = '# Details\n\nEditable child paragraph.\n\n- [ ] Child task\n'
const root = (page: Page) => page.frameLocator(ROOT)
const section = (frame: FrameLocator, path = CHILD) => frame.locator(`[data-document-embed="${path}"]`)
const child = (frame: FrameLocator, path = CHILD) => section(frame, path).frameLocator('iframe')
const paragraph = (frame: FrameLocator) => frame.locator('p').filter({ hasText: /^Editable child paragraph\./ })

async function open(page: Page, source: string, files: Record<string, string> = {}, viewer = false) {
  const fake = await fakeSupabase(page)
  const id = crypto.randomUUID()
  const owner = viewer ? '5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f' : person.id
  const remote = fake.server.remote(owner)
  await remote.createProject(id, 'Embedded documents')
  await remote.saveFiles(id, crypto.randomUUID(), Object.entries({[PARENT]:source, [CHILD]:CHILD_TEXT, ...files})
    .map(([path, content]) => ({op:'put' as const, path, content})))
  if (viewer) fake.server.share(id, person.id, 'viewer')
  await signedIn(page)
  await page.goto(new URL(`projects/${id}/${PARENT}`, APP_URL).href)
  if ((page.viewportSize()?.width ?? 1000) < 640) {
    await expect(page.getByRole('button', {name:'Back to files and projects'})).toBeVisible({timeout:20_000})
  } else await expect(page.getByRole('status').filter({hasText:'Synced'})).toBeVisible({timeout:20_000})
  await showView(page, 'Rendered')
  await expect(root(page).getByRole('heading', {name:'Parent', exact:true})).toBeVisible()
  return {fake, id}
}

async function append(page: Page, frame: FrameLocator, suffix: string) {
  const target = paragraph(frame)
  // Click its last glyph before End so a phone's wrapped paragraph edits
  // at the paragraph end instead of the end of its first visual line.
  const point = await target.evaluate(element => {
    const text = element.firstChild!
    const range = document.createRange()
    range.setStart(text, (text.textContent?.length ?? 1) - 1)
    range.setEnd(text, text.textContent?.length ?? 1)
    const glyph = range.getBoundingClientRect(), box = element.getBoundingClientRect()
    return {x:Math.min(box.width - 1, glyph.right - box.x + 2), y:glyph.y - box.y + glyph.height / 2}
  })
  await target.click({position:point})
  await page.keyboard.press('End')
  await page.keyboard.type(suffix)
  await expect(paragraph(frame)).toHaveText(`Editable child paragraph.${suffix}`)
}

async function saveParent(page: Page) {
  await page.getByRole('button', {name:'File actions', exact:true}).click()
  await page.getByRole('menuitem', {name:'Save', exact:true}).click()
}

test('expands lazily, retains edits when collapsed, grows with content and saves child from parent', async ({page}) => {
  const source = `# Parent\n\nBefore.\n\n<Document src="${CHILD}" title="Details" defaultCollapsed />\n\nAfter.\n`
  const long = CHILD_TEXT + '\n' + Array.from({length:35}, (_, i) => `Long child paragraph ${i + 1}.`).join('\n\n') + '\n'
  const {fake, id} = await open(page, source, {[CHILD]:long})
  const embed = section(root(page))
  const toggle = embed.getByRole('button', {name:'Details', exact:true})
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(embed.locator('iframe')).toHaveCount(0)
  await toggle.click()
  const inner = child(root(page))
  await expect(paragraph(inner)).toBeVisible()
  await append(page, inner, ' EDITED')
  await expect(embed.getByText('Unsaved', {exact:true})).toBeVisible()
  await expect.poll(() => inner.locator('html').evaluate(() => innerHeight)).toBeGreaterThan(1_000)
  const sizing = await inner.locator('html').evaluate(() => ({height:innerHeight, content:document.documentElement.scrollHeight}))
  expect(sizing.height).toBeGreaterThan(1_000)
  expect(sizing.content).toBeLessThanOrEqual(sizing.height + 2)
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(embed.locator('iframe')).toHaveCount(1)
  await toggle.click()
  await expect(paragraph(inner)).toHaveText('Editable child paragraph. EDITED')
  await saveParent(page)
  await expect.poll(() => fake.server.content(id, CHILD)).toBe(long.replace('Editable child paragraph.', 'Editable child paragraph. EDITED'))
  expect(fake.server.content(id, PARENT)).toBe(source)
  await expect(embed.getByText('Unsaved', {exact:true})).toHaveCount(0)
})

test('two embeds and the standalone tab share one draft and undo history', async ({page}) => {
  const source = `# Parent\n\n<Document src="${CHILD}" title="First" />\n\n<Document src="${CHILD}" title="Second" />\n`
  const {fake, id} = await open(page, source)
  const embeds = root(page).locator(`[data-document-embed="${CHILD}"]`)
  const first = embeds.nth(0).frameLocator('iframe')
  const second = embeds.nth(1).frameLocator('iframe')
  await expect(paragraph(first)).toHaveText('Editable child paragraph.')
  await expect(paragraph(second)).toHaveText('Editable child paragraph.')
  await append(page, first, ' SHARED')
  await expect(paragraph(second)).toHaveText('Editable child paragraph. SHARED')
  await embeds.first().getByRole('button', {name:'Open separately'}).click()
  await expect(page.getByRole('tab', {name:`${CHILD}, unsaved changes`})).toHaveAttribute('aria-selected', 'true')
  await showView(page, 'Source')
  const editor = page.locator('.monaco-editor:visible .view-lines')
  await expect(editor).toContainText('Editable child paragraph. SHARED')
  await editor.click()
  // Monaco follows the Windows user agent configured by these fixtures;
  // Playwright's ControlOrMeta follows the host OS instead.
  await page.keyboard.press('Control+z')
  await expect(editor).not.toContainText('SHARED')
  await page.keyboard.press('Control+Shift+z')
  await expect(editor).toContainText('SHARED')
  await page.getByRole('tab', {name:new RegExp(`^${PARENT.replace('.', '\\.')}(?:, unsaved changes)?$`)}).click()
  await expect(paragraph(first)).toHaveText('Editable child paragraph. SHARED')
  await expect(paragraph(second)).toHaveText('Editable child paragraph. SHARED')
  await saveParent(page)
  await expect.poll(() => fake.server.content(id, CHILD)).toBe(CHILD_TEXT.replace('Editable child paragraph.', 'Editable child paragraph. SHARED'))
  expect(fake.server.content(id, PARENT)).toBe(source)
})

test('undo and Save shortcut from inside a child target that child', async ({page}) => {
  const source = `# Parent\n\nUntouched parent paragraph.\n\n<Document src="${CHILD}" />\n`
  const {fake, id} = await open(page, source)
  const inner = child(root(page))
  await expect(paragraph(inner)).toBeVisible()
  await append(page, inner, ' CHILD')
  await page.keyboard.press('ControlOrMeta+z')
  await expect(paragraph(inner)).toHaveText('Editable child paragraph.')
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(paragraph(inner)).toHaveText('Editable child paragraph. CHILD')
  await page.keyboard.press('ControlOrMeta+s')
  await expect.poll(() => fake.server.content(id, CHILD)).toBe(CHILD_TEXT.replace('Editable child paragraph.', 'Editable child paragraph. CHILD'))
  expect(fake.server.content(id, PARENT)).toBe(source)
})

test('nested documents report cycles and missing files in place', async ({page}) => {
  const nested = 'notes/nested.mdx'
  const missing = 'notes/missing.md'
  const source = `# Parent\n\n<Document src="${nested}" />\n\n<Document src="${missing}" />\n`
  await open(page, source, {[nested]:`# Nested\n\n<Document src="${PARENT}" />\n`})
  const inner = child(root(page), nested)
  await expect(inner.getByRole('heading', {name:'Nested', exact:true})).toBeVisible()
  await expect(section(inner, PARENT)).toContainText(/circular|cycle|itself/i)
  await expect(section(root(page), missing)).toContainText(/not found|missing|does not exist/i)
  await expect(section(inner, PARENT).locator('iframe')).toHaveCount(0)
})

test('viewer can expand and read a child without edit controls or saves', async ({page}) => {
  const source = `# Parent\n\n<Document src="${CHILD}" title="Details" defaultCollapsed />\n`
  const {fake, id} = await open(page, source, {}, true)
  const embed = section(root(page))
  await embed.getByRole('button', {name:'Details', exact:true}).click()
  const inner = child(root(page))
  await expect(paragraph(inner)).toHaveText('Editable child paragraph.')
  await expect(inner.getByRole('textbox', {name:'Rendered document'})).toHaveAttribute('contenteditable','false')
  await paragraph(inner).click()
  await page.keyboard.type(' REJECTED')
  await expect(paragraph(inner)).toHaveText('Editable child paragraph.')
  await expect(embed.getByRole('button', {name:'Save document'})).toHaveCount(0)
  await expect(inner.getByRole('button', {name:'+ Insert block'})).toHaveCount(0)
  expect(fake.requests.filter(request => request.url().endsWith('/rpc/save_files'))).toHaveLength(0)
  expect(fake.server.content(id, CHILD)).toBe(CHILD_TEXT)
})

test('right-click inserts an existing document and omits the parent from choices', async ({page}) => {
  const source = '# Parent\n\nInsert here.\n\nUntouched tail.\n'
  const {fake, id} = await open(page, source)
  const frame = root(page)
  await frame.getByText('Insert here.', {exact:true}).click({button:'right'})
  await frame.getByRole('menu', {name:'Insert block'}).getByRole('menuitem', {name:'Document', exact:true}).click()
  const dialog = frame.getByRole('dialog', {name:'Insert block'})
  const paths = dialog.getByLabel('Resource file')
  await expect(paths.locator(`option[value="${PARENT}"]`)).toHaveCount(0)
  await paths.selectOption(CHILD)
  await dialog.getByRole('button', {name:'Insert', exact:true}).click()
  await section(frame).getByRole('button', {name:'Details',exact:true}).click()
  await expect(paragraph(child(frame))).toHaveText('Editable child paragraph.')
  await saveParent(page)
  await expect.poll(() => fake.server.content(id, PARENT)).toContain(`<Document src="${CHILD}"`)
  expect(fake.server.content(id, CHILD)).toBe(CHILD_TEXT)
})

test('expanded document controls are accessible', async ({page}) => {
  await open(page, `# Parent\n\n<Document src="${CHILD}" title="Details" />\n`)
  await expect(paragraph(child(root(page)))).toBeVisible()
  const results = await new AxeBuilder({page}).include('main').analyze()
  expect(results.violations).toEqual([])
})

test('shared child code waits for an explicit Run document click', async ({page}) => {
  const path = 'notes/code.mdx'
  await open(page, `# Parent\n\n<Document src="${path}" title="Code" />\n`, {
    [path]:'# Code\n\n{(() => "child-code-ran")()}\n',
  }, true)
  const embed = section(root(page),path)
  await expect(embed.getByRole('button', {name:'Run document'})).toBeVisible()
  await expect(child(root(page),path).getByText('child-code-ran', {exact:true})).toHaveCount(0)
  await embed.getByRole('button', {name:'Run document'}).click()
  await expect(child(root(page),path).getByText('child-code-ran', {exact:true})).toBeVisible()
})

test('inline draft survives reload while the saved files stay unchanged', async ({page}) => {
  const source = `# Parent\n\n<Document src="${CHILD}" />\n`
  const {fake,id} = await open(page,source)
  await expect(paragraph(child(root(page)))).toBeVisible()
  await append(page,child(root(page)),' RECOVERED')
  await expect(section(root(page)).getByText('Unsaved', {exact:true})).toBeVisible()
  // A rendered edit is optimistic until its source patch and local storage
  // transaction finish, as in the ordinary offline-draft journey.
  await expect(section(root(page)).getByRole('button', {name:'Save document'})).toBeEnabled()
  await page.waitForTimeout(300)
  await page.reload()
  await expect(paragraph(child(root(page)))).toHaveText('Editable child paragraph. RECOVERED', {timeout:20_000})
  expect(fake.server.content(id,CHILD)).toBe(CHILD_TEXT)
  expect(fake.server.content(id,PARENT)).toBe(source)
})

test('renaming an expanded child updates the parent reference and releases its old session', async ({page}) => {
  const source = `# Parent\n\n<Document src="${CHILD}" title="Details" />\n`
  const {fake,id} = await open(page,source)
  await expect(paragraph(child(root(page)))).toBeVisible()
  const files = page.getByRole('navigation', {name:'Workspace files'}).first()
  const folder = files.getByRole('button', {name:'notes',exact:true,expanded:false})
  if (await folder.count()) await folder.click()
  await files.getByRole('button', {name:`Actions for ${CHILD}`,exact:true}).click()
  await page.getByRole('menuitem', {name:'Rename',exact:true}).click()
  const dialog = page.getByRole('dialog', {name:'Rename in notes'})
  await dialog.getByLabel('New file name').fill('renamed.md')
  await dialog.getByLabel('New file name').press('Enter')
  await expect(dialog).toBeHidden()
  await expect.poll(() => fake.server.content(id,PARENT)).toBe(source.replace(CHILD,'notes/renamed.md'))
  await expect(paragraph(child(root(page),'notes/renamed.md'))).toHaveText('Editable child paragraph.')
  expect(fake.server.content(id,CHILD)).toBeUndefined()
  await expect(section(root(page),CHILD)).toHaveCount(0)
})

test('phone uses one parent preview and saves an inline child without a standalone tab', async ({page}) => {
  await page.setViewportSize({width:390,height:844})
  const source = `# Parent\n\n<Document src="${CHILD}" title="Details" />\n`
  const {fake,id} = await open(page,source)
  await expect(paragraph(child(root(page)))).toBeVisible()
  await expect(page.locator('iframe[title="Isolated document preview"]')).toHaveCount(1)
  await append(page,child(root(page)),' PHONE')
  await section(root(page)).getByRole('button', {name:'Save document'}).click()
  await expect.poll(() => fake.server.content(id,CHILD)).toBe(CHILD_TEXT.replace('Editable child paragraph.','Editable child paragraph. PHONE'))
  expect(fake.server.content(id,PARENT)).toBe(source)
})

test('removing an embed retains the child file and its unsaved draft', async ({page}) => {
  const {fake,id} = await open(page,`# Parent\n\n<Document src="${CHILD}" />\n`)
  await expect(paragraph(child(root(page)))).toBeVisible()
  await append(page,child(root(page)),' RETAINED')
  await expect(section(root(page)).getByRole('button', {name:'Save document'})).toBeEnabled()
  await showView(page,'Source')
  const editor = page.locator('.monaco-editor:visible .view-lines')
  await editor.click()
  await page.keyboard.press('Control+a')
  await page.keyboard.type('# Parent\n\nRemoved embed.\n')
  await expect(editor).not.toContainText('<Document')
  await saveParent(page)
  await expect.poll(() => fake.server.content(id,PARENT)).toBe('# Parent\n\nRemoved embed.\n')
  await page.getByRole('navigation', {name:'Workspace files'}).first().getByRole('button', {name:CHILD,exact:true}).click()
  await expect(editor).toContainText('Editable child paragraph. RETAINED')
  await expect(page.getByRole('tab', {name:`${CHILD}, unsaved changes`})).toHaveAttribute('aria-selected','true')
  await saveParent(page)
  await expect.poll(() => fake.server.content(id,CHILD)).toBe(CHILD_TEXT.replace('Editable child paragraph.','Editable child paragraph. RETAINED'))
})

test('closing and reopening a moved child preserves its inline connection and history', async ({page}) => {
  await open(page,`# Parent\n\n<Document src="${CHILD}" title="Details" />\n`)
  await expect(paragraph(child(root(page)))).toBeVisible()
  await section(root(page)).getByRole('button', {name:'Open separately'}).click()
  const files = page.getByRole('navigation', {name:'Workspace files'}).first()
  await files.getByRole('button', {name:`Actions for ${CHILD}`,exact:true}).click()
  await page.getByRole('menuitem', {name:'Rename',exact:true}).click()
  const dialog = page.getByRole('dialog', {name:'Rename in notes'})
  await dialog.getByLabel('New file name').fill('moved.md')
  await dialog.getByLabel('New file name').press('Enter')
  await expect(dialog).toBeHidden()
  const moved = 'notes/moved.md'
  await expect(page.getByRole('tab', {name:moved,exact:true})).toHaveAttribute('aria-selected','true')
  await page.getByRole('tab', {name:PARENT,exact:true}).click()
  await expect(paragraph(child(root(page),moved))).toHaveText('Editable child paragraph.')
  await append(page,child(root(page),moved),' MOVED')
  await section(root(page),moved).getByRole('button', {name:'Open separately'}).click()
  await page.getByRole('tab', {name:`${moved}, unsaved changes`}).locator('[data-slot="tab-close"]').click()
  await expect(paragraph(child(root(page),moved))).toHaveText('Editable child paragraph. MOVED')
  await section(root(page),moved).getByRole('button', {name:'Open separately'}).click()
  await showView(page,'Source')
  const editor = page.locator('.monaco-editor:visible .view-lines')
  await expect(editor).toContainText('Editable child paragraph. MOVED')
  await editor.click()
  await page.keyboard.press('Control+z')
  await expect(editor).not.toContainText('MOVED')
  await page.getByRole('tab', {name:PARENT,exact:true}).click()
  await expect(paragraph(child(root(page),moved))).toHaveText('Editable child paragraph.')
})

test('synthetic document controls cannot save a draft or open a tab', async ({page}) => {
  const {fake,id} = await open(page,`# Parent\n\n<Document src="${CHILD}" />\n`)
  await expect(paragraph(child(root(page)))).toBeVisible()
  await append(page,child(root(page)),' UNSAVED')
  const embed = section(root(page))
  await expect(embed.getByRole('button', {name:'Save document'})).toBeEnabled()
  for (const name of ['Save document','Open separately']) {
    await embed.getByRole('button', {name,exact:true}).evaluate(button => (button as HTMLButtonElement).click())
  }
  await page.waitForTimeout(1_200)
  await expect(page.getByRole('tab', {name:new RegExp(`^${CHILD.replace('.', '\\.')}`)})).toHaveCount(0)
  expect(fake.requests.filter(request => request.url().endsWith('/rpc/save_files'))).toHaveLength(0)
  expect(fake.server.content(id,CHILD)).toBe(CHILD_TEXT)
  await expect(paragraph(child(root(page)))).toHaveText('Editable child paragraph. UNSAVED')
})
