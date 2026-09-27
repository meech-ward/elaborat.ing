import AxeBuilder from "./axe.ts"
import { expect, test, type Page } from "@playwright/test"
import { fakeSupabase, person, quiet, signedIn, type FakeSupabase } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

// On a desktop a drawing or a diagram can show its source over the left half
// of its canvas (Split). While the source parses, edits in either reach the
// other; while it does not, the canvas is view-only and keeps the last valid
// scene. Phones have no Split.

test.describe.configure({ timeout: 90_000 })
test.use({ viewport: { width: 1280, height: 800 } })

const element = (id: string, type: string, x: number, y: number, extra: Record<string, unknown> = {}) => ({
  id, type, x, y, width: 160, height: 80, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "#a5d8ff", fillStyle: "solid",
  strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [], frameId: null, index: `a${id.length}`,
  roundness: null, seed: 1, version: 1, versionNonce: 1, isDeleted: false, boundElements: [], updated: 1, link: null, locked: false,
  ...extra,
})
const BOX = element("box", "rectangle", 0, 0)
const LABEL = element("label-1", "text", 20, 120, {
  width: 120, height: 25, text: "From source", originalText: "From source", fontSize: 20, fontFamily: 5,
  textAlign: "left", verticalAlign: "top", containerId: null, autoResize: true, lineHeight: 1.25, backgroundColor: "transparent",
})
/** A drawing whose last line closes its elements, so the source can be edited there. */
const DRAWING = `{"type":"excalidraw","version":2,"source":"https://excalidraw.com","appState":{"viewBackgroundColor":"#ffffff"},"files":{},"elements":[
${JSON.stringify(BOX)}
]}`

const projectUrl = (id: string, file?: string) => new URL(`projects/${id}${file ? `/${file}` : ""}`, APP_URL).href
const view = (page: Page, name: string) => page.getByRole("group", { name: /^(Drawing|Diagram) view$/ }).getByRole("button", { name, exact: true })
const status = (page: Page) => page.locator(".wb-native-view [aria-live]").first()
const sourcePanel = (page: Page) => page.locator(".wb-native-source")
const sourceText = (page: Page) => page.locator(".wb-native-source .monaco-editor:visible .view-lines")
const viewMode = (page: Page) => page.locator(".excalidraw.excalidraw--view-mode")
const saves = (fake: FakeSupabase) => fake.requests.filter((request) => request.url().endsWith("/rpc/save_files")).length

async function openProject(page: Page, files: Record<string, string>, file: string) {
  const fake = await fakeSupabase(page)
  const remote = fake.server.remote(person.id)
  const id = crypto.randomUUID()
  await remote.createProject(id, "Canvases")
  for (const [name, content] of Object.entries(files)) await remote.saveFiles(id, crypto.randomUUID(), [{ op: "put", path: name, content }])
  await signedIn(page)
  await page.goto(projectUrl(id, file))
  await expect(page.locator(".excalidraw canvas").first()).toBeVisible({ timeout: 45_000 })
  return { fake, id }
}

async function toSplit(page: Page) {
  await view(page, "Split").click()
  await expect(view(page, "Split")).toHaveAttribute("aria-pressed", "true")
  await expect(sourceText(page)).toBeVisible()
}

/** Put the cursor at the end of the drawing's elements, before its last line's `]}`. */
async function atEndOfElements(page: Page) {
  await sourceText(page).click()
  await page.keyboard.press("ControlOrMeta+End")
  await page.keyboard.press("Home")
}

test("a drawing in Split: the source over the left half, source edits reach the canvas, canvas moves rewrite the source, and one save writes the file", async ({ page }) => {
  const { fake, id } = await openProject(page, { "sketch.excalidraw": DRAWING }, "sketch.excalidraw")
  await expect(status(page)).toContainText("1 elements")
  await toSplit(page)

  // The canvas still fills the window; the source panel covers the left half of the editor's area.
  await expect.poll(() => page.locator(".excalidraw canvas").first().boundingBox()).toEqual({ x: 0, y: 0, width: 1280, height: 800 })
  const panel = (await sourcePanel(page).boundingBox())!
  const editor = (await page.locator(".wb-main-panel").boundingBox())!
  expect(Math.abs(panel.x - editor.x)).toBeLessThan(2)
  expect(Math.abs(panel.x + panel.width - (editor.x + editor.width / 2))).toBeLessThan(2)
  // The tool island sits over the uncovered canvas, right of the panel.
  const tools = (await page.getByRole("group", { name: "Drawing tools" }).boundingBox())!
  expect(tools.x).toBeGreaterThan(panel.x + panel.width)

  // A text element typed in the source appears on the canvas (the editor closes each brace and quote as it opens).
  await atEndOfElements(page)
  await page.keyboard.type(`,${JSON.stringify(LABEL).slice(0, -1)}`)
  await expect(status(page)).toContainText("2 elements · 1 text")
  // Half-typed JSON left the canvas view-only; the finished text gives editing back.
  await expect(viewMode(page)).toHaveCount(0)

  // Moving the shapes on the canvas rewrites their x in the source.
  await page.mouse.click(panel.x + panel.width + 60, 300)
  await page.keyboard.press("ControlOrMeta+a")
  for (let step = 0; step < 3; step += 1) await page.keyboard.press("ArrowRight")
  await expect(sourceText(page)).toContainText('"x": 3,')
  await expect(sourceText(page)).toContainText('"id": "box"')

  const before = saves(fake)
  await page.keyboard.press("ControlOrMeta+s")
  await expect(status(page)).toContainText("Saved sketch.excalidraw.")
  await expect.poll(() => saves(fake) - before).toBe(1)
  await quiet(fake, 1_000)
  expect(saves(fake) - before).toBe(1)
  const saved = JSON.parse(fake.server.content(id, "sketch.excalidraw")!) as { elements: Array<{ id: string; x: number; text?: string }> }
  expect(saved.elements.map(({ id, x, text }) => ({ id, x, text }))).toEqual([
    { id: "box", x: 3, text: undefined },
    { id: "label-1", x: 23, text: "From source" },
  ])
})

test("invalid JSON in a drawing's Split leaves the canvas view-only with the error, and fixing it restores editing", async ({ page }) => {
  await openProject(page, { "sketch.excalidraw": DRAWING }, "sketch.excalidraw")
  await toSplit(page)
  await expect(viewMode(page)).toHaveCount(0)

  // A trailing comma.
  await atEndOfElements(page)
  await page.keyboard.type(",")
  await expect(page.getByRole("alert").filter({ hasText: "This is not a valid drawing" })).toBeVisible()
  await expect(viewMode(page)).toBeVisible()
  // The canvas keeps its last valid scene, and Split stays until the text parses.
  await expect(status(page)).toContainText("1 elements")
  await view(page, "Canvas").click()
  await expect(view(page, "Split")).toHaveAttribute("aria-pressed", "true")

  await atEndOfElements(page)
  await page.keyboard.press("Delete")
  await expect(page.getByRole("alert").filter({ hasText: "This is not a valid drawing" })).toHaveCount(0)
  await expect(viewMode(page)).toHaveCount(0)
  await view(page, "Canvas").click()
  await expect(view(page, "Canvas")).toHaveAttribute("aria-pressed", "true")
  await expect(sourcePanel(page)).toBeHidden()
})

test("the view shortcuts switch a drawing's views, and the buttons show them", async ({ page }) => {
  await openProject(page, { "sketch.excalidraw": DRAWING }, "sketch.excalidraw")
  await expect(view(page, "Code")).toHaveAttribute("aria-keyshortcuts", "Control+Alt+1")
  await expect(view(page, "Split")).toHaveAttribute("aria-keyshortcuts", "Control+Alt+2")
  await expect(view(page, "Canvas")).toHaveAttribute("aria-keyshortcuts", "Control+Alt+3")

  await page.keyboard.press("Control+Alt+Digit2")
  await expect(view(page, "Split")).toHaveAttribute("aria-pressed", "true")
  await expect(sourceText(page)).toBeVisible()
  // The keys still switch while the source editor has the keyboard.
  await sourceText(page).click()
  await page.keyboard.press("Control+Alt+Digit1")
  await expect(view(page, "Code")).toHaveAttribute("aria-pressed", "true")
  await expect(page.locator(".excalidraw canvas").first()).toBeHidden()
  await page.keyboard.press("Control+Alt+Digit3")
  await expect(view(page, "Canvas")).toHaveAttribute("aria-pressed", "true")
  await expect(sourcePanel(page)).toBeHidden()
})

test("a diagram in Split updates its canvas as the code changes, and is view-only while the code does not compile", async ({ page }) => {
  await openProject(page, { "flow.d2": "a -> b\n" }, "flow.d2")
  await expect(page.getByText("Compiling diagram…")).toHaveCount(0, { timeout: 45_000 })
  const count = async () => Number(/(\d+) elements/.exec(await status(page).innerText())?.[1] ?? "0")
  const first = await count()
  await expect(view(page, "Code")).toHaveAttribute("aria-keyshortcuts", "Control+Alt+1")
  await page.keyboard.press("Control+Alt+Digit2")
  await expect(view(page, "Split")).toHaveAttribute("aria-pressed", "true")

  await sourceText(page).click()
  await page.keyboard.press("ControlOrMeta+End")
  await page.keyboard.type("b -> c\n")
  await expect.poll(count, { timeout: 30_000 }).toBeGreaterThan(first)
  const second = await count()

  // A connection with no destination (the code editor would auto-close a brace into valid D2).
  await page.keyboard.type("c ->")
  await expect(page.getByRole("alert").filter({ hasText: "[d2/syntax]" })).toBeVisible({ timeout: 30_000 })
  await expect(viewMode(page)).toBeVisible()
  expect(await count()).toBe(second)

  await page.keyboard.type(" d")
  await expect(page.getByRole("alert").filter({ hasText: "[d2/syntax]" })).toHaveCount(0, { timeout: 30_000 })
  await expect(viewMode(page)).toHaveCount(0)
  await expect.poll(count, { timeout: 30_000 }).toBeGreaterThan(second)
})

test("axe finds nothing in Split for a drawing and a diagram at 1280", async ({ page }) => {
  await openProject(page, { "sketch.excalidraw": DRAWING, "flow.d2": "a -> b\n" }, "sketch.excalidraw")
  const check = async () => {
    const results = await new AxeBuilder({ page }).include('[data-slot="editor-header"]').include(".wb-native-source").analyze()
    expect(results.violations.map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => node.target) }))).toEqual([])
  }
  await toSplit(page)
  await check()
  await page.getByRole("navigation", { name: "Workspace files" }).getByRole("button", { name: "flow.d2", exact: true }).click()
  await expect(page.getByText("Compiling diagram…")).toHaveCount(0, { timeout: 45_000 })
  await toSplit(page)
  await check()
})

test("a drawing left in Split opens on its canvas on a phone", async ({ page }) => {
  await openProject(page, { "sketch.excalidraw": DRAWING }, "sketch.excalidraw")
  await toSplit(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.reload()
  await expect(page.locator(".excalidraw canvas").first()).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole("button", { name: "Canvas", exact: true })).toHaveAttribute("aria-pressed", "true")
  await expect(page.getByRole("button", { name: "Split", exact: true })).toHaveCount(0)
  await expect(sourcePanel(page)).toBeHidden()
})
