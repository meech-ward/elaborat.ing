import { expect, test, type Page } from './fixtures.ts'
import { fakeSupabase, person, signedIn } from './fake-supabase.ts'
import { APP_URL } from './urls.ts'

test.use({ viewport: { width: 1280, height: 900 } })
test.describe.configure({ timeout: 60000 })
const frame = (page: Page) => page.frameLocator('iframe[title="Isolated document preview"]:visible')
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64')

test('existing text files with an image extension keep their editable source', async ({ page }) => {
  const fake = await fakeSupabase(page)
  const remote = fake.server.remote(person.id)
  const id = crypto.randomUUID()
  await remote.createProject(id, 'Old text files')
  await remote.saveFiles(id, crypto.randomUUID(), [{ op: 'put', path: 'old.png', content: 'This is existing text, not image bytes.' }])
  await signedIn(page)
  await page.goto(new URL(`projects/${id}/old.png`, APP_URL).href)
  await expect(page.locator('.monaco-editor:visible .view-lines').first()).toContainText('This is existing text, not image bytes.')
  await expect(page.getByText('This image has not downloaded completely.', { exact: false })).toHaveCount(0)
})

async function openPicker(page: Page) {
  await fakeSupabase(page)
  await page.goto(APP_URL)
  await page.getByRole('banner').getByRole('link', { name: 'Start writing' }).click()
  await page.getByRole('button', { name: 'New file' }).click()
  await page.getByRole('menuitem', { name: 'New note', exact: true }).click()
  await page.getByRole('textbox', { name: /^Name of the new note in / }).fill('formats.mdx')
  await page.keyboard.press('Enter')
  const lines = page.locator('.monaco-editor:visible .view-lines').first()
  await expect(lines).toBeVisible()
  await lines.click()
  await page.keyboard.type('# Images\n\nAnchor paragraph.\n')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('tab', { name: 'formats.mdx', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Rendered', exact: true }).click()
  await frame(page).getByText('Anchor paragraph.', { exact: true }).click({ button: 'right' })
  await frame(page).getByRole('menuitem', { name: 'Image', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Insert image', exact: true })
  await expect(dialog).toBeVisible()
  return dialog
}

test('SVG viewBox dimensions survive upload and unsafe SVG never runs or fetches', async ({ page, appErrors }) => {
  const outside: string[] = []
  page.on('request', request => { if (request.url().includes('image-security.example')) outside.push(request.url()) })
  const dialog = await openPicker(page)
  appErrors.expect("SVG element image is not supported")
  const input = dialog.getByLabel('Upload images', { exact: true })
  await input.setInputFiles({ name: 'unsafe.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><image href="https://image-security.example/secret.png"/></svg>') })
  await expect(dialog.getByRole('alert')).toContainText(/not supported|unsupported/i)
  await expect(dialog.getByRole('button', { name: 'Insert image', exact: true })).toBeDisabled()
  expect(outside).toEqual([])
  await input.setInputFiles({ name: 'vector.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><rect width="100" height="50" fill="red"/></svg>') })
  await expect(dialog.getByText(/vector.svg.*100 × 50/)).toBeVisible()
  await dialog.getByLabel('Image description', { exact: true }).fill('A red rectangle')
  await dialog.getByRole('button', { name: 'Insert image', exact: true }).click()
  await expect(frame(page).getByRole('img', { name: 'A red rectangle', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('tab', { name: 'formats.mdx', exact: true })).toBeVisible()
  await page.reload()
  await expect(frame(page).getByRole('img', { name: 'A red rectangle', exact: true })).toBeVisible({ timeout: 15000 })
  expect(outside).toEqual([])
})

test('description suggestion is explicit, sends only a thumbnail and remains editable', async ({ page }) => {
  const requests: Array<Record<string, unknown>> = []
  await page.route('**/chatgpt/status', route => route.fulfill({ json: { connected: true, plan: true, models: [{ slug: 'test-model' }] } }))
  await page.route('**/chatgpt/responses', async route => {
    requests.push(route.request().postDataJSON() as Record<string, unknown>)
    await route.fulfill({ contentType: 'text/event-stream', body: 'data: {"type":"response.output_text.delta","delta":"A red pixel"}\n\ndata: [DONE]\n\n' })
  })
  const dialog = await openPicker(page)
  await dialog.getByLabel('Upload images', { exact: true }).setInputFiles({ name: 'red.png', mimeType: 'image/png', buffer: png })
  await expect(dialog.getByLabel('Image description', { exact: true })).toBeEnabled()
  expect(requests).toHaveLength(0)
  await dialog.getByRole('button', { name: 'Suggest a description', exact: true }).click()
  await expect(dialog.getByLabel('Image description', { exact: true })).toHaveValue('A red pixel')
  expect(requests).toHaveLength(1)
  const payload = JSON.stringify(requests[0])
  expect(payload).toContain('data:image/webp;base64,')
  expect(payload.length).toBeLessThan(45000)
  await expect(frame(page).locator('img')).toHaveCount(0)
  await dialog.getByLabel('Image description', { exact: true }).fill('A red pixel, edited')
  await dialog.getByRole('button', { name: 'Insert image', exact: true }).click()
  await expect(frame(page).getByRole('img', { name: 'A red pixel, edited', exact: true })).toBeVisible()
})
