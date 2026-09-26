import AxeBuilder from "@axe-core/playwright"
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
  if (phone) await expect(page.getByRole("button", { name: "Navigation" }).first()).toBeVisible({ timeout: 15_000 })
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
  await page.locator(".wb-native-toolbar").getByRole("button", { name: "File actions" }).click()
  await page.getByRole("menuitem", { name }).click()
}

test("a diagram compiles in the browser, its first save writes the generated files in one call, and reopening writes nothing", async ({ page }) => {
  const { fake, id } = await openProject(page, { "flow.d2": "a -> b: hello\n" }, "flow.d2")
  await compiled(page)
  expect(await elementCount(page)).toBeGreaterThan(2)
  // The generated files do not exist yet, so the diagram has something to save.
  await expect(status(page)).toContainText("Unsaved changes")

  const before = saves(fake).length
  await page.keyboard.press("ControlOrMeta+s")
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
  await page.keyboard.press("ControlOrMeta+s")
  await expect(status(page)).toContainText("Saved flow.d2 and its generated files.")
  await expect.poll(() => fake.server.content(id, "flow.excalidraw")).toBeDefined()

  // Another device rewrites the generated canvas, and it syncs here.
  const theirs = fake.server.content(id, "flow.excalidraw")!.replace('"elements"', '"theirs": true, "elements"')
  const version = fake.server.projects.get(id)!.files.get("flow.excalidraw")!.version
  await fake.server.remote(person.id).saveFiles(id, crypto.randomUUID(), [{ op: "put", path: "flow.excalidraw", content: theirs, base_version: version }])
  await page.getByRole("button", { name: "Sync now" }).click()
  await expect(page.getByRole("status").filter({ hasText: "Synced" })).toBeVisible()

  await page.getByRole("button", { name: "Code" }).click()
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

  await page.getByRole("button", { name: "Code" }).click()
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

test("a new diagram from the menu is saved with an example and compiles", async ({ page }) => {
  const { fake, id } = await openProject(page, { "a.md": "# A\n" }, "a.md")
  await page.getByRole("button", { name: "Workbench menu" }).click()
  await page.getByRole("menuitem", { name: "New diagram" }).click()
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
    const results = await new AxeBuilder({ page }).include(".wb-native-toolbar").analyze()
    expect(results.violations.map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => node.target) }))).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
  })
})
