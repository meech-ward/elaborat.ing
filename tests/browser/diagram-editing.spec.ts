import AxeBuilder from "./axe.ts"
import { expect, test, type Page } from "@playwright/test"
import { fakeSupabase, person, signedIn, type FakeSupabase } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

// D2 diagrams in a project: D2 compiles in the browser, the source and its
// two generated files save together in one server call, reopening reuses the
// generated files, code changes reach the canvas on Regenerate, and a syntax
// error keeps the last valid canvas.

const projectUrl = (id: string, file?: string) => new URL(`projects/${id}${file ? `/${file}` : ""}`, APP_URL).href

// The first compile loads D2's 8 MB WebAssembly build.
test.describe.configure({ timeout: 90_000 })

async function openProject(page: Page, files: Record<string, string>, file?: string, phone = false) {
  const fake = await fakeSupabase(page)
  const remote = fake.server.remote(person.id)
  const id = crypto.randomUUID()
  await remote.createProject(id, "Diagrams")
  for (const [name, content] of Object.entries(files)) await remote.saveFiles(id, crypto.randomUUID(), [{ op: "put", path: name, content }])
  await signedIn(page)
  await page.goto(projectUrl(id, file))
  if (phone) await expect(page.getByRole("button", { name: "Back to files and projects" })).toBeVisible({ timeout: 15_000 })
  else await expect(page.getByRole("status").filter({ hasText: "Synced" })).toBeVisible({ timeout: 15_000 })
  return { fake, id }
}

const saves = (fake: FakeSupabase) =>
  fake.requests
    .filter((request) => request.url().endsWith("/rpc/save_files"))
    .map((request) => (request.postDataJSON() as { changes: Array<{ op: string; path: string }> }).changes)
const status = (page: Page) => page.locator(".wb-native-view [aria-live]").first()
const elementCount = async (page: Page) => Number(/(\d+) elements/.exec(await status(page).innerText())?.[1] ?? "0")

async function compiled(page: Page) {
  await expect(page.getByText("Compiling diagram…")).toHaveCount(0, { timeout: 45_000 })
  await expect(page.locator(".excalidraw canvas").first()).toBeVisible()
}

async function menuAction(page: Page, name: string) {
  await page.getByRole("button", { name: "File actions" }).click()
  await page.getByRole("menuitem", { name }).click()
}

test("a diagram compiles in the browser, opening saves its generated files in one call, and reopening writes nothing", async ({ page }) => {
  const { fake, id } = await openProject(page, { "flow.d2": "a -> b: hello\n" }, "flow.d2")
  const before = saves(fake).length
  await compiled(page)
  expect(await elementCount(page)).toBeGreaterThan(2)
  // The generated files follow from the saved code, so opening saves them: nothing is left unsaved.
  await expect(status(page)).toContainText("Saved flow.d2 and its generated files.")
  await expect.poll(() => fake.server.content(id, "flow.excalidraw")).toBeDefined()
  const native = JSON.parse(fake.server.content(id, "flow.excalidraw")!)
  expect(native.type).toBe("excalidraw")
  expect(native.elements.length).toBeGreaterThan(2)
  expect(JSON.parse(fake.server.content(id, "flow.d2.json")!)).toMatchObject({ baseline: expect.any(Object) })
  expect(fake.server.content(id, "flow.d2")).toBe("a -> b: hello\n")
  const sent = saves(fake).slice(before)
  expect(sent).toHaveLength(1)
  expect(sent[0].map((change) => change.path).sort()).toEqual(["flow.d2.json", "flow.excalidraw"])

  const settled = saves(fake).length
  await page.reload()
  await compiled(page)
  await expect(status(page)).toContainText("Saved")
  await page.waitForTimeout(1_000)
  expect(saves(fake).length, "reopening a saved diagram sends nothing").toBe(settled)
})

test("when a generated file changed elsewhere, a save keeps all three files as they were", async ({ page }) => {
  const { fake, id } = await openProject(page, { "flow.d2": "a -> b\n" }, "flow.d2")
  await compiled(page)
  await expect(status(page)).toContainText("Saved flow.d2 and its generated files.")
  await expect.poll(() => fake.server.content(id, "flow.excalidraw")).toBeDefined()

  // Another device rewrites the generated canvas, and it syncs here.
  const theirs = fake.server.content(id, "flow.excalidraw")!.replace('"elements"', '"theirs": true, "elements"')
  const version = fake.server.projects.get(id)!.files.get("flow.excalidraw")!.version
  await fake.server.remote(person.id).saveFiles(id, crypto.randomUUID(), [{ op: "put", path: "flow.excalidraw", content: theirs, base_version: version }])
  await page.getByRole("button", { name: "Account and settings" }).click()
  await page.getByRole("menuitem", { name: "Sync now" }).click()
  await expect(page.getByRole("status").filter({ hasText: "Synced" })).toBeVisible()

  await page.getByRole("group", { name: "Diagram view" }).getByRole("button", { name: "Code", exact: true }).click()
  await page.locator(".monaco-editor:visible .view-lines").first().click()
  await page.keyboard.press("ControlOrMeta+End")
  await page.keyboard.type("b -> c\n")
  await page.keyboard.press("ControlOrMeta+s")
  await expect(page.getByRole("alert").filter({ hasText: "flow.excalidraw changed after you started editing this diagram, so nothing was saved." })).toBeVisible()
  await page.waitForTimeout(1_000)
  expect(fake.server.content(id, "flow.d2"), "the source was not saved without its canvas").toBe("a -> b\n")
  expect(fake.server.content(id, "flow.excalidraw")).toBe(theirs)
})

test("a code change reaches the canvas on Regenerate, and a syntax error keeps the last valid canvas", async ({ page }) => {
  await openProject(page, { "flow.d2": "a -> b\n" }, "flow.d2")
  await compiled(page)
  const first = await elementCount(page)

  await page.getByRole("group", { name: "Diagram view" }).getByRole("button", { name: "Code", exact: true }).click()
  const code = page.locator(".monaco-editor:visible .view-lines").first()
  await code.click()
  await page.keyboard.press("ControlOrMeta+End")
  await page.keyboard.type("b -> c\n")
  await menuAction(page, "Regenerate")
  await expect.poll(() => elementCount(page), { timeout: 30_000 }).toBeGreaterThan(first)
  const second = await elementCount(page)

  // A connection with no destination (the code editor would auto-close a brace into valid D2).
  await code.click()
  await page.keyboard.press("ControlOrMeta+End")
  await page.keyboard.type("c ->")
  await menuAction(page, "Regenerate")
  await expect(page.getByRole("alert").filter({ hasText: "[d2/syntax]" })).toBeVisible({ timeout: 30_000 })
  await expect(status(page)).toContainText("The code does not compile, so the last valid canvas was kept.")
  expect(await elementCount(page)).toBe(second)
})

type SceneElement = { id: string; x: number; y: number; width: number; height: number; isDeleted?: boolean; points?: [number, number][] }

/**
 * Where an element's middle is on screen, from the scene in the saved
 * `flow.excalidraw`. The canvas opens at zoom 1 with the middle of the
 * drawing's bounds in the middle of the canvas (Excalidraw's scroll to
 * content), and nothing here scrolls or zooms it.
 */
async function onScreen(page: Page, elements: SceneElement[], id: string) {
  const extent = (element: SceneElement) => {
    const xs = element.points ? element.points.map(([x]) => element.x + x) : [element.x, element.x + element.width]
    const ys = element.points ? element.points.map(([, y]) => element.y + y) : [element.y, element.y + element.height]
    return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) }
  }
  const all = elements.filter((element) => !element.isDeleted).map(extent)
  const middle = { x: (Math.min(...all.map((e) => e.x1)) + Math.max(...all.map((e) => e.x2))) / 2, y: (Math.min(...all.map((e) => e.y1)) + Math.max(...all.map((e) => e.y2))) / 2 }
  const target = extent(elements.find((element) => element.id === id)!)
  const canvas = (await page.locator(".excalidraw.excalidraw-container").boundingBox())!
  return {
    x: canvas.x + canvas.width / 2 + (target.x1 + target.x2) / 2 - middle.x,
    y: canvas.y + canvas.height / 2 + (target.y1 + target.y2) / 2 - middle.y,
  }
}

/** Open a diagram, which saves its generated canvas, and return that canvas's elements. */
async function savedDiagram(page: Page, source: string) {
  const { fake, id } = await openProject(page, { "flow.d2": source }, "flow.d2")
  await compiled(page)
  await expect(status(page)).toContainText("Saved flow.d2 and its generated files.")
  await expect.poll(() => fake.server.content(id, "flow.excalidraw")).toBeDefined()
  const elements = (JSON.parse(fake.server.content(id, "flow.excalidraw")!) as { elements: SceneElement[] }).elements
  return { fake, id, elements }
}

/** Replace the text Excalidraw opened for editing (it selects the old text) and finish with Escape. */
async function replaceText(page: Page, from: string, to: string) {
  const editor = page.locator("textarea.excalidraw-wysiwyg")
  await expect(editor).toHaveValue(from)
  await page.keyboard.type(to)
  await page.keyboard.press("Escape")
  await expect(editor).toHaveCount(0)
}

test("renaming a node's text on the canvas writes its label into the code, and Save stores it", async ({ page }) => {
  const source = "# Two steps\na -> b\n"
  const { fake, id, elements } = await savedDiagram(page, source)

  const node = await onScreen(page, elements, "d2:a:label")
  await page.mouse.dblclick(node.x, node.y)
  await replaceText(page, "a", "Alpha")
  await page.getByRole("group", { name: "Diagram view" }).getByRole("button", { name: "Code", exact: true }).click()
  const code = page.locator(".monaco-editor:visible .view-lines").first()
  // The label sync's own form: a quoted scalar marked as the canvas's, after the untouched source.
  const expected = `${source}a.label: "Alpha" # canvas-label\n`
  await expect(code).toContainText('a.label: "Alpha" # canvas-label')
  await expect(code).toContainText("# Two steps")

  await page.keyboard.press("ControlOrMeta+s")
  await expect(status(page)).toContainText("Saved flow.d2 and its generated files.")
  await expect.poll(() => fake.server.content(id, "flow.d2")).toBe(expected)
})

test("renaming a connection's label on the canvas stays a canvas-only change, with a notice", async ({ page }) => {
  const source = "a -> b: hello\n"
  const { fake, id, elements } = await savedDiagram(page, source)

  // D2 connections are elbow arrows, and their label sits on the segment's
  // middle, where a double-click resets the segment. Select the arrow by its
  // label and press Enter, Excalidraw's key for editing a label.
  const label = await onScreen(page, elements, "d2:(a -> b)[0]:label")
  await page.mouse.click(label.x, label.y)
  await page.keyboard.press("Enter")
  await replaceText(page, "hello", "goodbye")
  await expect(status(page)).toContainText("This generated text stays a canvas-only change. Only node labels update the D2 code.")
  await page.getByRole("group", { name: "Diagram view" }).getByRole("button", { name: "Code", exact: true }).click()
  const code = page.locator(".monaco-editor:visible .view-lines").first()
  await expect(code).toContainText("a -> b: hello")
  await expect(code).not.toContainText("label")

  // Saving keeps the renamed text on the canvas and the code as it was.
  await page.keyboard.press("ControlOrMeta+s")
  await expect(status(page)).toContainText("Saved flow.d2 and its generated files.")
  await expect.poll(() => fake.server.content(id, "flow.excalidraw")).toContain('"goodbye"')
  expect(fake.server.content(id, "flow.d2")).toBe(source)
})

test("a new diagram from the menu is saved with an example and compiles", async ({ page }) => {
  const { fake, id } = await openProject(page, { "a.md": "# A\n" }, "a.md")
  await page.getByRole("button", { name: "New file" }).click()
  await page.getByRole("menuitem", { name: "New diagram" }).click()
  // It asks for a name first; Enter takes the one proposed.
  await expect(page.getByRole("textbox", { name: /^Name of the new diagram in / })).toHaveValue("untitled.d2")
  await page.keyboard.press("Enter")
  await expect(page.getByRole("tab", { name: "untitled.d2" })).toHaveAttribute("aria-selected", "true")
  await compiled(page)
  await expect.poll(() => fake.server.content(id, "untitled.d2")).toContain("->")
})

test("a note shows pictures of the drawing and diagram it embeds, made from their saved files", async ({ page }) => {
  const scene = JSON.stringify({ type: "excalidraw", version: 2, elements: [
    { id: "box", type: "rectangle", x: 0, y: 0, width: 120, height: 60, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent",
      fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [], frameId: null, index: "a0",
      roundness: null, seed: 1, version: 1, versionNonce: 1, isDeleted: false, boundElements: [], updated: 1, link: null, locked: false },
  ], appState: {}, files: {} })
  const note = '# Page\n\n<Drawing src="art/sketch.excalidraw" />\n\n<Diagram src="flow.d2" />\n'
  const { fake } = await openProject(page, { "art/sketch.excalidraw": scene, "flow.d2": "a -> b\n", "page.mdx": note }, "page.mdx")
  const before = saves(fake).length
  await page.getByRole("button", { name: "Rendered" }).click()
  const frame = page.frameLocator('iframe[title="Isolated document preview"]')
  await expect(frame.locator('[data-resource-pixels="art/sketch.excalidraw"] svg')).toBeVisible({ timeout: 30_000 })
  await expect(frame.locator('[data-resource-pixels="flow.d2"] svg')).toBeVisible({ timeout: 45_000 })
  await expect(frame.getByText(/Preview unavailable/)).toHaveCount(0)

  // Each picture opens in a reading viewer that zooms without changing anything.
  await frame.getByRole("button", { name: "View drawing art/sketch.excalidraw", exact: true }).click()
  const viewer = page.getByRole("dialog", { name: "Drawing: art/sketch.excalidraw", exact: true })
  await expect(viewer).toBeVisible()
  // It opens fitted to the width; Fit shows the whole drawing, which is 100%.
  const percent = viewer.getByLabel(/Zoom \d+ percent/)
  await viewer.getByRole("button", { name: "Fit", exact: true }).click()
  await expect(percent).toHaveText("100%")
  await viewer.getByRole("button", { name: "Zoom in", exact: true }).click()
  await expect(percent).not.toHaveText(/100%/)
  await page.keyboard.press("Escape")
  await expect(viewer).toBeHidden()
  await frame.getByRole("button", { name: "View diagram flow.d2", exact: true }).click()
  const diagram = page.getByRole("dialog", { name: "Diagram: flow.d2", exact: true })
  await diagram.getByRole("button", { name: "Close", exact: true }).click()
  await expect(diagram).toBeHidden()
  expect(saves(fake).length, "picturing embeds writes nothing").toBe(before)
})

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test("the diagram view fits, and axe finds nothing in its toolbar", async ({ page }) => {
    await openProject(page, { "flow.d2": "a -> b\n" }, "flow.d2", true)
    await compiled(page)
    const results = await new AxeBuilder({ page }).include('[data-slot="phone-header"]').analyze()
    expect(results.violations.map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => node.target) }))).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
  })
})
