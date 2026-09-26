import { expect, test, type Page } from "@playwright/test"
import { HARNESS_URL } from "./urls.ts"

// The drawing canvas must never change what it was not asked to change.
// Edits go through Excalidraw's own UI; the harness reads back the saved
// scene and the live canvas pixels.

type Element = { id: string; type: string; isDeleted?: boolean; x: number; y: number; width: number; height: number; text?: string; originalText?: string; containerId?: string | null; groupIds?: string[] } & Record<string, unknown>
type Scene = { elements: Element[]; appState: Record<string, unknown>; files?: Record<string, unknown> }
type Reading = { current: Scene; original: Scene; changeCount: number; handlerError: string | null; saved: { noop: boolean; text: string }; originalSource: string }

test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })

const read = (page: Page) => page.evaluate(() => window.harness.read() as unknown as Reading)
const sample = (page: Page, box: number[]) => page.evaluate((box) => window.harness.sample(box), box)
// The canvas paints on a later frame.
const settle = (page: Page) => page.waitForTimeout(500)
const active = (scene: Scene, id: string) => scene.elements.some((element) => element.id === id && !element.isDeleted)

async function open(page: Page, errors: string[]) {
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  await page.goto(HARNESS_URL, { waitUntil: "networkidle" })
  await page.locator(".excalidraw canvas").first().waitFor()
  await page.evaluate(() => document.fonts.ready)
  await settle(page)
  return read(page)
}

async function push(page: Page, scene: Scene) {
  await page.evaluate((scene) => window.harness.push(scene as never), scene)
  await settle(page)
}

async function reopen(page: Page, text: string) {
  await page.evaluate((text) => window.harness.reopen(text), text)
  await settle(page)
}

async function drawRectangle(page: Page, x: number, y: number, width: number, height: number) {
  await page.keyboard.press("2")
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + width, y + height, { steps: 8 })
  await page.mouse.up()
  await settle(page)
}

/** Look at a scene with the given scroll, at zoom 1, nothing selected. */
function viewport(scene: Scene, scrollX: number, scrollY: number): Scene {
  return { ...scene, appState: { ...scene.appState, zoom: { value: 1 }, scrollX, scrollY, selectedElementIds: {}, viewBackgroundColor: "#ffffff" } }
}

function expectOthersUnchanged(original: Scene, current: Scene, except: string[] = []) {
  const byId = new Map(current.elements.map((element) => [element.id, element]))
  for (const element of original.elements) {
    if (!except.includes(element.id)) expect(byId.get(element.id), `unrelated element ${element.id}`).toEqual(element)
  }
}

test("opening a drawing and saving it untouched keeps the file byte for byte", async ({ page }) => {
  const errors: string[] = []
  const opened = await open(page, errors)
  expect(opened.changeCount).toBe(0)
  expect(opened.saved.noop).toBe(true)
  expect(opened.saved.text).toBe(opened.originalSource)
  expect(errors).toEqual([])
})

test("a shape can be drawn, deleted and brought back with one undo each", async ({ page }) => {
  const errors: string[] = []
  const initial = await open(page, errors)
  // Scroll away from the existing content, so the observed area starts blank.
  await push(page, viewport(initial.current, -100_000, -100_000))
  const box = [580, 380, 240, 140]
  expect((await sample(page, box)).dark).toBe(0)

  await page.mouse.click(900, 650)
  await drawRectangle(page, 600, 400, 200, 100)
  const drawn = await read(page)
  const originalIds = new Set(initial.original.elements.map((element) => element.id))
  const added = drawn.current.elements.filter((element) => !originalIds.has(element.id) && !element.isDeleted)
  expect(added).toHaveLength(1)
  const id = added[0].id
  expectOthersUnchanged(initial.original, drawn.current)
  expect((await sample(page, box)).dark).toBeGreaterThan(100)

  await page.keyboard.press("Delete")
  await settle(page)
  const deleted = await read(page)
  expect(deleted.changeCount).toBeGreaterThan(drawn.changeCount)
  expect(active(deleted.current, id)).toBe(false)
  expect((await sample(page, box)).dark).toBe(0)

  await page.keyboard.press("ControlOrMeta+z")
  await settle(page)
  const undone = await read(page)
  expect(undone.changeCount).toBeGreaterThan(deleted.changeCount)
  expect(active(undone.current, id)).toBe(true)
  expect((await sample(page, box)).dark).toBeGreaterThan(100)
  expectOthersUnchanged(initial.original, undone.current)

  await drawRectangle(page, 850, 400, 160, 100)
  const second = await read(page)
  const secondId = second.current.elements.find((element) => !originalIds.has(element.id) && element.id !== id && !element.isDeleted)?.id
  expect(secondId).toBeDefined()
  expect((await sample(page, [830, 380, 200, 140])).dark).toBeGreaterThan(100)
  await page.keyboard.press("ControlOrMeta+z")
  await settle(page)
  const secondUndo = await read(page)
  expect(active(secondUndo.current, secondId!)).toBe(false)
  expect(active(secondUndo.current, id)).toBe(true)
  expect((await sample(page, [830, 380, 200, 140])).dark).toBe(0)
  expectOthersUnchanged(initial.original, secondUndo.current)

  await reopen(page, secondUndo.saved.text)
  const reopened = await read(page)
  expect(reopened.saved.noop).toBe(true)
  expect(active(reopened.current, id)).toBe(true)
  expect(active(reopened.current, secondId!)).toBe(false)
  expect(errors).toEqual([])
})

test("editing a text changes only that text, found by its id", async ({ page }) => {
  const errors: string[] = []
  const baseline = await open(page, errors)
  const target = baseline.current.elements.find(
    (element) => element.type === "text" && !element.isDeleted && !element.containerId && !element.groupIds?.length && element.width > 40 && element.width < 500 && element.height < 150,
  )
  expect(target, "the fixture has a free-standing text").toBeDefined()
  await push(page, viewport(baseline.current, 400 - target!.x, 300 - target!.y))
  await page.keyboard.press("v")
  await page.mouse.dblclick(400 + target!.width / 2, 300 + target!.height / 2)
  const editor = page.locator("textarea.excalidraw-wysiwyg")
  await editor.waitFor({ state: "visible", timeout: 5_000 })
  const before = target!.originalText ?? target!.text
  await expect(editor).toHaveValue(before!)
  const expected = `${before} EDITED`
  await editor.fill(expected)
  await page.keyboard.press("Escape")
  await settle(page)

  const edited = await read(page)
  const after = edited.current.elements.find((element) => element.id === target!.id)!
  expect(after.text).toBe(expected)
  expect(edited.current.elements).toHaveLength(baseline.original.elements.length)
  expectOthersUnchanged(baseline.original, edited.current, [target!.id])
  const layout = ["text", "originalText", "rawText", "width", "height", "x", "y", "version", "versionNonce", "updated", "autoResize"]
  for (const key of Object.keys(target!).filter((key) => !layout.includes(key))) expect(after[key], `text field ${key}`).toEqual(target![key])

  await reopen(page, edited.saved.text)
  const reopened = await read(page)
  expect(reopened.saved.noop).toBe(true)
  expect(reopened.saved.text).toBe(edited.saved.text)
  expect(reopened.current.elements.find((element) => element.id === target!.id)?.text).toBe(expected)
  expect(errors).toEqual([])
})

test("an image draws, survives a reopen, and exports to PNG and SVG", async ({ page }) => {
  const errors: string[] = []
  const baseline = await open(page, errors)
  const anchor = baseline.current.elements.find((element) => !element.isDeleted)!
  const [imageX, imageY] = [anchor.x + 600, anchor.y + 400]
  const image = await page.evaluate(([x, y]) => window.harness.image(x, y), [imageX, imageY])
  await push(page, viewport(baseline.current, 600 - imageX, 400 - imageY))
  expect((await sample(page, [600, 400, 120, 120])).magenta).toBe(0)

  const withImage = { ...baseline.current, elements: [...baseline.current.elements, image.element as unknown as Element], files: { ...baseline.current.files, [image.file.id]: image.file } }
  await push(page, viewport(withImage, 600 - imageX, 400 - imageY))
  await expect.poll(async () => (await sample(page, [600, 400, 120, 120])).magenta, { timeout: 10_000 }).toBeGreaterThan(9_000)
  expect((await sample(page, [600, 400, 120, 120])).cyan).toBeGreaterThan(4_000)

  const saved = await read(page)
  expectOthersUnchanged(baseline.original, saved.current)
  expect(saved.current.files?.[image.file.id]).toEqual(image.file)
  await reopen(page, saved.saved.text)
  const reopened = await read(page)
  expect(reopened.saved.noop).toBe(true)
  expect(reopened.current.files?.[image.file.id]).toEqual(image.file)
  const reopenedImage = reopened.current.elements.find((element) => element.id === image.element.id)!
  for (const key of ["id", "type", "x", "y", "width", "height", "fileId", "scale", "crop", "opacity", "isDeleted"]) {
    expect(reopenedImage[key], `image field ${key}`).toEqual((image.element as Record<string, unknown>)[key])
  }

  const exported = await page.evaluate(() => window.harness.exports())
  expect(exported.signature).toBe("89504e470d0a1a0a")
  expect(exported.pngColors.magenta).toBeGreaterThan(9_000)
  expect(exported.pngColors.cyan).toBeGreaterThan(4_000)
  expect(exported.svg).toContain("<image")
  expect(exported.svg).toContain(image.file.dataURL)
  expect(errors).toEqual([])
  expect((await read(page)).handlerError).toBeNull()
})
