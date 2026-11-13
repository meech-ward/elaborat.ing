import { expect, test } from './fixtures.ts'
import { accepted, clickAt, frameOf, load, openHarness, paragraph, press, selection, source } from './rendered-support.ts'
import { fakeSupabase, person, quiet, signedIn } from './fake-supabase.ts'
import { APP_URL } from './urls.ts'
import { showView } from './views.ts'

test.use({ serviceWorkers: 'allow', viewport: { width: 1280, height: 900 } })

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80"><rect width="200" height="80" fill="#36c"/></svg>'
const following = 'Paragraph after the drawing.'

for (const [name, embed, format] of [
  ['single-line JSX', '<Drawing src="sketch.excalidraw" />', 'mdx'],
  ['multi-line JSX', '<Drawing\n  src="sketch.excalidraw"\n/>', 'mdx'],
] as const) {
  test(`Enter before the paragraph after ${name} shows the source-backed empty line`, async ({ page }) => {
    await openHarness(page)
    const note = `Before the drawing.\n\n${embed}\n\n${following}\n`
    const mark = await load(page, note, format, following)
    await page.evaluate(svg => window.renderedHarness.setResources({ 'sketch.excalidraw': svg }), svg)
    const pixels = frameOf(page).locator('[data-resource-pixels="sketch.excalidraw"]')
    await expect(pixels).toBeVisible()
    const before = await paragraph(page, following).boundingBox()
    await pixels.evaluate(element => { element.setAttribute('data-test-retained', 'yes') })
    await clickAt(page, following, 2)
    await press(page, 'Home')
    await press(page, 'Enter')
    await accepted(page, mark)
    await expect.poll(() => source(page)).toBe(note.replace(`\n\n${following}`, `\n\n\n\n${following}`))
    const empty = frameOf(page).locator('.ProseMirror > p').filter({ hasText: /^$/ })
    await expect(empty).toHaveCount(1)
    await expect(empty).toBeVisible()
    expect((await empty.boundingBox())!.height).toBeGreaterThan(10)
    expect((await paragraph(page, following).boundingBox())!.y).toBeGreaterThan(before!.y + 10)
    expect((await selection(page)).focus).toEqual({ paragraph: following, offset: 0 })
    await expect(pixels).toHaveAttribute('data-test-retained', 'yes')
    await page.keyboard.type('Continued. ')
    await expect.poll(() => source(page)).toBe(note.replace(`\n\n${following}`, `\n\n\n\nContinued. ${following}`))
    await expect(page.getByText(/^Edit not applied:/)).toHaveCount(0)
  })
}

test('Enter on a keyboard-selected drawing creates a visible editable line after it', async ({ page }) => {
  await openHarness(page)
  const note = `Before the drawing.\n\n<Drawing src="sketch.excalidraw" />\n\n${following}\n`
  const mark = await load(page, note, 'mdx', following)
  await page.evaluate(svg => window.renderedHarness.setResources({ 'sketch.excalidraw': svg }), svg)
  const pixels = frameOf(page).locator('[data-resource-pixels="sketch.excalidraw"]')
  await expect(pixels).toBeVisible()
  await pixels.evaluate(element => { element.setAttribute('data-test-retained', 'yes') })
  await clickAt(page, 'Before the drawing.', 2)
  await press(page, 'End')
  await press(page, 'ArrowRight')
  await expect(frameOf(page).locator('.ProseMirror > [data-fluid-object]')).toHaveClass(/ProseMirror-selectednode/)
  await press(page, 'Enter')
  await accepted(page, mark)
  await expect.poll(() => source(page)).toBe(note.replace(`\n\n${following}`, `\n\n\n\n${following}`))
  const empty = frameOf(page).locator('.ProseMirror > p').filter({ hasText: /^$/ })
  await expect(empty).toBeVisible()
  expect((await selection(page)).focus).toEqual({ paragraph: '', offset: 0 })
  await page.keyboard.type('After the drawing.')
  await expect.poll(() => source(page)).toBe(note.replace(`\n\n${following}`, `\n\nAfter the drawing.\n\n${following}`))
  await expect(pixels).toHaveAttribute('data-test-retained', 'yes')
})

test('one extra source newline between a drawing and its paragraph shows an editable blank line', async ({ page }) => {
  await openHarness(page)
  const note = `<Drawing src="sketch.excalidraw" />\n\n${following}\n`
  await load(page, note, 'mdx', following)
  await page.evaluate(svg => window.renderedHarness.setResources({ 'sketch.excalidraw': svg }), svg)
  await expect(frameOf(page).locator('[data-resource-pixels="sketch.excalidraw"]')).toBeVisible()
  await page.evaluate(text => window.renderedHarness.edit(text), note.replace('\n\n', '\n\n\n'))
  const empty = frameOf(page).locator('.ProseMirror > p').filter({ hasText: /^$/ })
  await expect(empty).toHaveCount(1)
  await expect(empty).toBeVisible()
  await empty.click()
  await press(page, 'Enter')
  expect((await selection(page)).focus).toEqual({ paragraph: '', offset: 0 })
  await page.keyboard.type('Typed in the gap.')
  await expect.poll(() => source(page)).toBe(note.replace('\n\n', '\n\nTyped in the gap.\n\n'))
  expect((await selection(page)).focus).toEqual({ paragraph: 'Typed in the gap.', offset: 'Typed in the gap.'.length })
  await expect(page.getByText(/^Edit not applied:/)).toHaveCount(0)
})

test('Source Enter beside a drawing survives Rendered Undo, Redo, Save and reopening', async ({ page }) => {
  test.setTimeout(90_000)
  const path = 'spacing.mdx'
  const original = `<Drawing src="sketch.excalidraw" />\n\n${following}\n`
  const spaced = original.replace('\n\n', '\n\n\n')
  const fake = await fakeSupabase(page)
  const remote = fake.server.remote(person.id)
  const id = crypto.randomUUID()
  await remote.createProject(id, 'Drawing spacing')
  await remote.saveFiles(id, crypto.randomUUID(), [
    { op: 'put', path, content: original },
    { op: 'put', path: 'sketch.excalidraw', content: JSON.stringify({ type: 'excalidraw', version: 2, elements: [
      { id: 'kept-box', type: 'rectangle', x: 0, y: 0, width: 200, height: 80, angle: 0, strokeColor: '#1e1e1e', backgroundColor: '#a5d8ff', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: 1, version: 1, versionNonce: 1, isDeleted: false, boundElements: [], updated: 1, link: null, locked: false },
    ] }) },
  ])
  await signedIn(page)
  await page.goto(new URL(`projects/${id}/${path}`, APP_URL).href)
  await showView(page, 'Source')
  const sourceLine = page.locator('.monaco-editor:visible .view-line').filter({ hasText: following })
  await expect(sourceLine).toBeVisible()
  await sourceLine.click()
  await press(page, 'Home')
  await page.keyboard.press('Enter')
  await showView(page, 'Rendered')
  const pixels = frameOf(page).locator('[data-resource-pixels="sketch.excalidraw"]')
  const empty = frameOf(page).locator('.ProseMirror > p').filter({ hasText: /^$/ })
  await expect(pixels).toBeVisible()
  await expect(empty).toHaveCount(1)
  await pixels.evaluate(element => { element.setAttribute('data-test-retained', 'yes') })
  await paragraph(page, following).click()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(empty).toHaveCount(0)
  await expect(pixels).toHaveAttribute('data-test-retained', 'yes')
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(empty).toHaveCount(1)
  await expect(pixels).toHaveAttribute('data-test-retained', 'yes')
  await empty.click()
  await press(page, 'Enter')
  expect((await selection(page)).focus).toEqual({ paragraph: '', offset: 0 })
  await page.keyboard.press('ControlOrMeta+s')
  await quiet(fake, 1_500)
  await expect.poll(() => fake.server.content(id, path)).toBe(spaced)
  await page.reload()
  await expect(pixels).toBeVisible({ timeout: 15_000 })
  await expect(empty).toHaveCount(1)
  await empty.click()
  await press(page, 'Backspace')
  await expect(empty).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+z')
  await expect(empty).toHaveCount(1)
  await expect(page.getByText(/^Edit not applied:/)).toHaveCount(0)
})
