import { readFileSync } from "node:fs"
import path from "node:path"
import AxeBuilder from "@axe-core/playwright"
import { expect, test, type Page } from "@playwright/test"
import { palettes } from "../../src/features/appearance/palettes.ts"
import { fakeSupabase, person, signedIn, type FakeSupabase } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

// Drawings in a project: the canvas opens without rewriting the file, edits
// save on the device and reach the server, unsaved edits survive a reload,
// the file can be edited as text, and exports download real files.

const projectUrl = (id: string, file?: string) => new URL(`projects/${id}${file ? `/${file}` : ""}`, APP_URL).href

test.describe.configure({ timeout: 60_000 })

const SCENE = `${JSON.stringify(
  {
    type: "excalidraw",
    version: 2,
    source: "https://excalidraw.com",
    elements: [
      {
        id: "box-1", type: "rectangle", x: 0, y: 0, width: 160, height: 80, angle: 0, strokeColor: "#1e1e1e",
        backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100,
        groupIds: [], frameId: null, index: "a0", roundness: null, seed: 1, version: 1, versionNonce: 1, isDeleted: false,
        boundElements: [], updated: 1, link: null, locked: false,
      },
    ],
    appState: { viewBackgroundColor: "#ffffff" },
    files: {},
  },
  null,
  2,
)}\n`
const OBSIDIAN = readFileSync(path.join(import.meta.dirname, "..", "..", "src", "features", "drawings", "fixtures", "synthetic.excalidraw.md"), "utf8")

async function openProject(page: Page, files: Record<string, string>, file?: string) {
  const fake = await fakeSupabase(page)
  const remote = fake.server.remote(person.id)
  const id = crypto.randomUUID()
  await remote.createProject(id, "Drawings")
  for (const [name, content] of Object.entries(files)) await remote.saveFiles(id, crypto.randomUUID(), [{ op: "put", path: name, content }])
  await signedIn(page)
  await page.goto(projectUrl(id, file))
  await expect(page.getByRole("status").filter({ hasText: "Synced" })).toBeVisible({ timeout: 15_000 })
  return { fake, id }
}

const saveCalls = (fake: FakeSupabase) => fake.requests.filter((request) => request.url().endsWith("/rpc/save_files")).length
const canvas = (page: Page) => page.locator(".excalidraw canvas").first()
const status = (page: Page) => page.locator(".wb-native-view [aria-live]").first()
const elements = (content: string | undefined) => (JSON.parse(content ?? "{}").elements as Array<{ isDeleted?: boolean }>).filter((element) => !element.isDeleted)

async function drawRectangle(page: Page) {
  const box = (await canvas(page).boundingBox())!
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2]
  // Focus the canvas on an empty spot (away from its corner controls), so the rectangle tool's key reaches it.
  await page.mouse.click(x + 200, y + 100)
  await page.keyboard.press("2")
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 140, y + 90, { steps: 8 })
  await page.mouse.up()
  await expect(status(page)).toContainText("Unsaved changes")
}

async function menuAction(page: Page, name: string) {
  await page.locator(".wb-native-toolbar").getByRole("button", { name: "File actions" }).click()
  await page.getByRole("menuitem", { name }).click()
}

test("a drawing opens on the canvas without being rewritten, and a shape drawn on it saves and reaches the server", async ({ page }) => {
  const { fake, id } = await openProject(page, { "art/sketch.excalidraw": SCENE }, "art/sketch.excalidraw")
  await expect(canvas(page)).toBeVisible()
  await expect(status(page)).toContainText("Saved")
  await expect(status(page)).toContainText("1 elements")
  const opened = saveCalls(fake)
  await page.waitForTimeout(1_500)
  expect(saveCalls(fake), "opening a drawing sends nothing").toBe(opened)
  expect(fake.server.content(id, "art/sketch.excalidraw")).toBe(SCENE)

  await drawRectangle(page)
  await expect(page.getByRole("tab", { name: "art/sketch.excalidraw" }).getByLabel("unsaved changes")).toBeVisible()
  await page.keyboard.press("ControlOrMeta+s")
  await expect(status(page)).toContainText("Saved art/sketch.excalidraw.")
  await expect(page.getByRole("tab", { name: "art/sketch.excalidraw" }).getByLabel("unsaved changes")).toHaveCount(0)
  await expect.poll(() => elements(fake.server.content(id, "art/sketch.excalidraw")).length).toBe(2)
  expect(JSON.parse(fake.server.content(id, "art/sketch.excalidraw")!).elements[0]).toMatchObject({ id: "box-1", x: 0, y: 0, width: 160 })
})

test("unsaved canvas edits survive a reload and are not sent to the server", async ({ page }) => {
  const { fake, id } = await openProject(page, { "sketch.excalidraw": SCENE }, "sketch.excalidraw")
  await expect(canvas(page)).toBeVisible()
  await drawRectangle(page)
  // Let the draft reach the device's storage.
  await page.waitForTimeout(500)
  await page.reload()
  await expect(canvas(page)).toBeVisible({ timeout: 15_000 })
  await expect(status(page)).toContainText("Unsaved changes")
  await expect(status(page)).toContainText("2 elements")
  expect(fake.server.content(id, "sketch.excalidraw")).toBe(SCENE)
})

test("an Obsidian drawing opens without being rewritten, and its text can be edited and checked", async ({ page }) => {
  const { fake, id } = await openProject(page, { "obsidian/system.excalidraw.md": OBSIDIAN }, "obsidian/system.excalidraw.md")
  await expect(canvas(page)).toBeVisible()
  await expect(status(page)).toContainText("Saved")
  await page.getByRole("button", { name: "Source" }).click()
  const source = page.locator(".monaco-editor:visible .view-lines").first()
  await expect(source).toContainText("excalidraw-plugin: parsed")
  await page.getByRole("button", { name: "Canvas" }).click()
  await expect(status(page)).toContainText("Saved")
  await page.waitForTimeout(1_000)
  expect(fake.server.content(id, "obsidian/system.excalidraw.md")).toBe(OBSIDIAN)

  // Breaking the file in the source view keeps the canvas's last valid scene.
  await page.getByRole("button", { name: "Source" }).click()
  await source.click()
  await page.keyboard.press("ControlOrMeta+a")
  await page.keyboard.type("not a drawing")
  await page.getByRole("button", { name: "Canvas" }).click()
  await expect(page.getByRole("alert").filter({ hasText: "This is not a valid drawing" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Source" })).toHaveAttribute("aria-pressed", "true")
  await page.keyboard.press("ControlOrMeta+s")
  await expect(status(page)).toContainText("Not saved: the file is not a valid drawing.")
  expect(fake.server.content(id, "obsidian/system.excalidraw.md")).toBe(OBSIDIAN)
})

test("a file that is not a valid drawing opens as text, and nothing is written", async ({ page }) => {
  const { fake, id } = await openProject(page, { "broken.excalidraw": "{ not json" }, "broken.excalidraw")
  await expect(page.getByRole("alert").filter({ hasText: "This file is not a valid drawing, so it opened as text" })).toBeVisible()
  await expect(page.locator(".monaco-editor:visible .view-lines").first()).toContainText("{ not json")
  await page.waitForTimeout(1_000)
  expect(fake.server.content(id, "broken.excalidraw")).toBe("{ not json")
})

test("a new drawing from the menu is saved empty and opens on the canvas", async ({ page }) => {
  const { fake, id } = await openProject(page, { "a.md": "# A\n" }, "a.md")
  await page.getByRole("button", { name: "Workbench menu" }).click()
  await page.getByRole("menuitem", { name: "New drawing" }).click()
  // It asks for a name first; Enter takes the one proposed.
  await expect(page.getByRole("textbox", { name: /^Name of the new drawing in / })).toHaveValue("untitled.excalidraw")
  await page.keyboard.press("Enter")
  await expect(page.getByRole("tab", { name: "untitled.excalidraw" })).toHaveAttribute("aria-selected", "true")
  await expect(canvas(page)).toBeVisible()
  await expect.poll(() => fake.server.content(id, "untitled.excalidraw")).toBe('{"type":"excalidraw","version":2,"elements":[]}')
})

test("exports download an SVG, a PNG and an Excalidraw file", async ({ page }) => {
  await openProject(page, { "obsidian/system.excalidraw.md": OBSIDIAN }, "obsidian/system.excalidraw.md")
  await expect(canvas(page)).toBeVisible()
  const download = async (name: string) => {
    const [file] = await Promise.all([page.waitForEvent("download"), menuAction(page, name)])
    const stream = await file.createReadStream()
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(chunk as Buffer)
    return { name: file.suggestedFilename(), bytes: Buffer.concat(chunks) }
  }
  const svg = await download("SVG")
  expect(svg.name).toBe("system.excalidraw.svg")
  expect(svg.bytes.toString("utf8")).toContain("<svg")
  const png = await download("PNG")
  expect(png.name).toBe("system.excalidraw.png")
  expect(png.bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a")
  const native = await download("Excalidraw")
  expect(native.name).toBe("system.excalidraw")
  expect(JSON.parse(native.bytes.toString("utf8"))).toMatchObject({ type: "excalidraw" })
})

test("a drawing changed on another device updates the open canvas when it has no unsaved edits", async ({ page }) => {
  const { fake, id } = await openProject(page, { "sketch.excalidraw": SCENE }, "sketch.excalidraw")
  await expect(status(page)).toContainText("1 elements")
  const scene = JSON.parse(SCENE)
  const second = { ...scene.elements[0], id: "box-2", x: 300, index: "a1" }
  const theirs = `${JSON.stringify({ ...scene, elements: [...scene.elements, second] }, null, 2)}\n`
  const version = fake.server.projects.get(id)!.files.get("sketch.excalidraw")!.version
  await fake.server.remote(person.id).saveFiles(id, crypto.randomUUID(), [{ op: "put", path: "sketch.excalidraw", content: theirs, base_version: version }])
  await page.getByRole("button", { name: "Sync now" }).click()
  await expect(status(page)).toContainText("2 elements")
  await expect(status(page)).toContainText("Saved")
  expect(fake.server.content(id, "sketch.excalidraw")).toBe(theirs)
})

test("on a desktop the canvas fills the window behind the panels, and the side panel keeps its own clicks", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  const { fake, id } = await openProject(page, { "sketch.excalidraw": SCENE }, "sketch.excalidraw")
  await expect(canvas(page)).toBeVisible()
  await expect.poll(() => canvas(page).boundingBox()).toEqual({ x: 0, y: 0, width: 1280, height: 800 })

  // The rectangle tool, selected, takes the palette's selected-tool colour.
  await page.mouse.click(900, 600)
  await page.keyboard.press("2")
  const scheme = await page.evaluate(() => (document.documentElement.dataset.scheme === "light" ? "light" : "dark"))
  const rgb = (hex: string) => `rgb(${[1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)).join(", ")})`
  await expect(page.locator(".App-toolbar .ToolIcon_type_radio:checked + .ToolIcon__icon")).toHaveCSS("background-color", rgb(palettes[0][scheme].toolOn))

  // A drag over the side panel stays there and draws nothing.
  const files = (await page.getByRole("navigation", { name: "Workspace files" }).boundingBox())!
  const [x, y] = [files.x + files.width / 2, files.y + files.height - 60]
  expect(await page.evaluate(([x, y]) => Boolean(document.elementFromPoint(x, y)?.closest(".wb-files-panel")), [x, y])).toBe(true)
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 60, y + 30, { steps: 5 })
  await page.mouse.up()
  await page.waitForTimeout(300)
  await expect(status(page)).toContainText("Saved")
  await expect(status(page)).toContainText("1 elements")

  // A rectangle drawn in the canvas area (clear of the tool's properties panel) saves.
  await page.mouse.move(760, 480)
  await page.mouse.down()
  await page.mouse.move(900, 570, { steps: 8 })
  await page.mouse.up()
  await expect(status(page)).toContainText("Unsaved changes")
  await page.keyboard.press("ControlOrMeta+s")
  await expect.poll(() => elements(fake.server.content(id, "sketch.excalidraw")).length).toBe(2)
})

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test("the drawing view fits, and axe finds nothing in its toolbar", async ({ page }) => {
    const fake = await fakeSupabase(page)
    const id = crypto.randomUUID()
    await fake.server.remote(person.id).createProject(id, "Drawings")
    await fake.server.remote(person.id).saveFiles(id, crypto.randomUUID(), [{ op: "put", path: "sketch.excalidraw", content: SCENE }])
    await signedIn(page)
    await page.goto(projectUrl(id, "sketch.excalidraw"))
    await expect(canvas(page)).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole("button", { name: "Canvas" })).toBeVisible()
    const results = await new AxeBuilder({ page }).include(".wb-native-toolbar").analyze()
    expect(results.violations.map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => node.target) }))).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
    const box = await canvas(page).boundingBox()
    expect(box && box.width <= 390 && box.height > 200).toBe(true)
  })
})
