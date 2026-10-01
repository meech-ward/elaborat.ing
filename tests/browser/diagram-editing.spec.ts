import AxeBuilder from "./axe.ts"
import { expect, test, type Page } from "@playwright/test"
import { fakeSupabase, person, signedIn, type FakeSupabase } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

// D2 diagrams in a project: D2 compiles in the browser, the source and its
// two generated files save together in one server call, reopening reuses the
// generated files, code changes reach the canvas on Regenerate, and a syntax
// error keeps the last valid canvas.

const projectUrl = (id: string, file?: string) => new URL(`projects/${id}${file ? `/${file}` : ""}`, APP_URL).href

// The first compile loads D2's engine, 22 MB of WebAssembly.
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

// The diagram's view loads its chunk before it shows "Compiling diagram…", so
// wait for the canvas itself: D2 loads and compiles first.
async function compiled(page: Page) {
  await expect(page.locator(".excalidraw canvas").first()).toBeVisible({ timeout: 45_000 })
  await expect(page.getByText("Compiling diagram…")).toHaveCount(0)
}

async function menuAction(page: Page, name: string) {
  await page.getByRole("button", { name: "File actions" }).click()
  await page.getByRole("menuitem", { name }).click()
}

test("a diagram compiles in the browser, opening saves its generated files in one call, and reopening writes nothing", async ({ page }) => {
  // Notes whether the header ever offers Save while the diagram opens.
  await page.addInitScript(() => {
    const seen = { save: false }
    Object.assign(window, { seenSave: seen })
    new MutationObserver(() => {
      if ([...document.querySelectorAll('[data-slot="editor-header"] button')].some((button) => button.textContent?.startsWith("Save"))) seen.save = true
    }).observe(document, { subtree: true, childList: true })
  })
  const { fake, id } = await openProject(page, { "flow.d2": "a -> b: hello\n" }, "flow.d2")
  const before = saves(fake).length
  await compiled(page)
  expect(await elementCount(page)).toBeGreaterThan(2)
  // The generated files follow from the saved code, so opening saves them: nothing is left unsaved.
  await expect(status(page)).toContainText("Saved flow.d2 and its generated files.")
  // That save is no edit of the person's: the header never offers Save for it, so nothing in it moves.
  expect(await page.evaluate(() => (window as unknown as { seenSave: { save: boolean } }).seenSave.save)).toBe(false)
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

test("a diagram compiles when the server labels D2's engine as something other than application/wasm", async ({ page }) => {
  // Streaming compilation needs that label; a copy on another server may send a generic one.
  let relabelled = 0
  await page.route("**/*.wasm", async (route) => {
    const response = await route.fetch()
    const headers: Record<string, string> = { ...response.headers(), "content-type": "application/octet-stream" }
    delete headers["content-encoding"]
    delete headers["content-length"]
    relabelled++
    await route.fulfill({ response, headers })
  })
  await openProject(page, { "flow.d2": "a -> b: hello\n" }, "flow.d2")
  await compiled(page)
  expect(await elementCount(page)).toBeGreaterThan(2)
  expect(relabelled).toBe(1)
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
 * `flow.excalidraw`. The canvas opens with the middle of the drawing's
 * bounds in the middle of the visible canvas area (the canvas controls'
 * layer), at the zoom its zoom island shows, and nothing here scrolls or
 * zooms it.
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
  const area = (await page.locator('[data-slot="canvas-controls"]').boundingBox())!
  const reset = await page.getByRole("button", { name: /^Reset zoom, now \d+%$/ }).getAttribute("aria-label")
  const zoom = Number(/(\d+)%/.exec(reset!)![1]) / 100
  return {
    x: area.x + area.width / 2 + ((target.x1 + target.x2) / 2 - middle.x) * zoom,
    y: area.y + area.height / 2 + ((target.y1 + target.y2) / 2 - middle.y) * zoom,
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
  const note = '# Page\n\n<Drawing src="art/sketch.excalidraw" />\n\n<Diagram src="flow.d2" />\n\n<Diagram src="other.d2" />\n\n<Diagram src="flow.d2" />\n'
  const labels = { "flow.d2": "sends", "other.d2": "gets back" }
  const { fake } = await openProject(
    page,
    { "art/sketch.excalidraw": scene, "flow.d2": "a -> b: sends\n", "other.d2": "direction: right\na -> b: gets back\n", "page.mdx": note },
    "page.mdx",
  )
  const before = saves(fake).length
  await page.getByRole("button", { name: "Rendered" }).click()
  const frame = page.frameLocator('iframe[title="Isolated document preview"]')
  await expect(frame.locator('[data-resource-pixels="art/sketch.excalidraw"] svg')).toBeVisible({ timeout: 30_000 })
  await expect(frame.locator('[data-resource-pixels="flow.d2"] svg')).toHaveCount(2, { timeout: 45_000 })
  await expect(frame.locator('[data-resource-pixels="other.d2"] svg')).toBeVisible({ timeout: 45_000 })
  await expect(frame.getByText(/Preview unavailable/)).toHaveCount(0)

  // Both diagrams have an arrow from a to b, and the note shows flow.d2
  // twice. Each copy is masked by its own picture's mask, which hides the
  // line under its label with the canvas's 5px gap around the label's box.
  const cutouts = await frame.locator("body").evaluate((body, labels) =>
    [...body.querySelectorAll("[data-resource-pixels] svg [mask]")].map((arrow) => {
      const picture = arrow.closest("[data-resource-pixels]")!.getAttribute("data-resource-pixels")!
      const id = /^url\("#(.+)"\)$/.exec(arrow.getAttribute("mask") ?? "")?.[1]
      const masks = [...body.querySelectorAll("mask")].filter((mask) => mask.id === id)
      const cut = masks[0]?.querySelector('rect[fill="#000"]')
      const label = [...arrow.closest("svg")!.querySelectorAll("g > text")].find((text) => text.textContent === labels[picture as keyof typeof labels])
      // The label's group is at translate(x y), turning about its centre: rotate(0 width/2 height/2).
      const [x, y, cx, cy] = /translate\(([-\d.]+) ([-\d.]+)\) rotate\(0 ([-\d.]+) ([-\d.]+)\)/.exec(label?.parentElement?.getAttribute("transform") ?? "")!.slice(1).map(Number)
      const [cutX, cutY, cutWidth, cutHeight] = ["x", "y", "width", "height"].map((name) => Number(cut?.getAttribute(name)))
      return {
        picture,
        masks: masks.length,
        own: masks[0]?.closest("[data-resource-pixels]") === arrow.closest("[data-resource-pixels]"),
        gap: [x - cutX, y - cutY, cutWidth - 2 * cx, cutHeight - 2 * cy].map((value) => Math.round(value * 100) / 100),
      }
    }), labels)
  expect(cutouts).toEqual(["flow.d2", "other.d2", "flow.d2"].map((picture) => ({ picture, masks: 1, own: true, gap: [5, 5, 10, 10] })))

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
  await frame.getByRole("button", { name: "View diagram flow.d2", exact: true }).first().click()
  const diagram = page.getByRole("dialog", { name: "Diagram: flow.d2", exact: true })
  await diagram.getByRole("button", { name: "Close", exact: true }).click()
  await expect(diagram).toBeHidden()
  expect(saves(fake).length, "picturing embeds writes nothing").toBe(before)
})

test("a note's drawing and diagram follow light and dark, and the viewer keeps a drawing's images in their colours", async ({ page }) => {
  // A pale yellow box, and an 8 by 8 picture: blue top left, red top right.
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAHElEQVR4nGMwSHgARw8MDOCIgYoSyBxkRVSUAACat1YBMJT5qgAAAABJRU5ErkJggg=="
  const shape = { angle: 0, strokeColor: "#1e1e1e", backgroundColor: "#ffec99", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 0,
    opacity: 100, groupIds: [], frameId: null, roundness: null, version: 1, versionNonce: 1, isDeleted: false, boundElements: [], updated: 1, link: null, locked: false }
  const scene = JSON.stringify({ type: "excalidraw", version: 2, elements: [
    { ...shape, id: "box", type: "rectangle", x: 0, y: 0, width: 160, height: 80, seed: 1, index: "a0" },
    { ...shape, id: "pic", type: "image", x: 200, y: 0, width: 80, height: 80, seed: 2, index: "a1", backgroundColor: "transparent", fileId: "f1", status: "saved", scale: [1, 1], crop: null },
  ], appState: {}, files: { f1: { id: "f1", mimeType: "image/png", dataURL: `data:image/png;base64,${png}`, created: 1 } } })
  await page.emulateMedia({ colorScheme: "light" })
  await openProject(page, { "sketch.excalidraw": scene, "flow.d2": "a -> b\n", "page.mdx": '# Page\n\n<Drawing src="sketch.excalidraw" />\n\n<Diagram src="flow.d2" />\n' }, "page.mdx")
  await page.getByRole("button", { name: "Rendered" }).click()
  const frame = page.frameLocator('iframe[title="Isolated document preview"]')
  const pictures = frame.locator("[data-resource-pixels] > svg")
  await expect(pictures).toHaveCount(2, { timeout: 45_000 })
  const filters = () => pictures.evaluateAll((svgs) => svgs.map((svg) => getComputedStyle(svg).filter))
  await expect.poll(filters).toEqual(["none", "none"])
  // The drawing's picture in the note shows its image (the frame allows
  // data: images): blue and red where the picture is, not the empty box.
  const noteColours = async () => {
    const png = (await pictures.first().screenshot()).toString("base64")
    return page.evaluate(async (data) => {
      const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], { type: "image/png" }))
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
      const context = canvas.getContext("2d")!
      context.drawImage(bitmap, 0, 0)
      // The picture is 300 by 100, however wide it shows.
      const scale = bitmap.width / 300
      const at = (x: number, y: number) => [...context.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data.slice(0, 3)]
      return { blue: at(230, 30), red: at(270, 30) }
    }, png)
  }
  await expect.poll(async () => {
    const { blue, red } = await noteColours()
    return blue[2] > 150 && Math.max(blue[0], blue[1]) < 130 && red[0] > 150 && Math.max(red[1], red[2]) < 110
  }, { message: "the drawing's image shows in the note" }).toBe(true)
  const light = await noteColours()
  // The system turning dark redraws both through Excalidraw's dark theme filter, with no reload.
  await page.emulateMedia({ colorScheme: "dark" })
  await expect.poll(filters).toEqual([expect.stringMatching(/^invert\(0\.93\) hue-rotate\(180deg\)$/), expect.stringMatching(/^invert\(0\.93\) hue-rotate\(180deg\)$/)])
  // The image keeps its colours, give or take, as Excalidraw's dark export
  // draws it: not lightened to the sky blue and pink the dark filter alone
  // makes (each of those is 60 or more off in some channel).
  const drift = async () => {
    const dark = await noteColours()
    return Math.max(...[0, 1, 2].flatMap((at) => [Math.abs(dark.blue[at] - light.blue[at]), Math.abs(dark.red[at] - light.red[at])]))
  }
  await expect.poll(drift, { message: "the drawing's image keeps its colours in the dark note" }).toBeLessThan(45)

  // The viewer shows the drawing as Excalidraw's dark export does: the
  // background and box dark, the picture's blue and red as they are.
  await frame.getByRole("button", { name: "View drawing sketch.excalidraw", exact: true }).click()
  const image = page.getByRole("dialog", { name: "Drawing: sketch.excalidraw", exact: true }).getByRole("img", { name: "Drawing preview of sketch.excalidraw" })
  // The picture is 300 by 100: the scene with 10 around it.
  const colours = () => image.evaluate(async (img: HTMLImageElement) => {
    await img.decode()
    const canvas = document.createElement("canvas")
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    const context = canvas.getContext("2d")!
    context.drawImage(img, 0, 0)
    const at = (x: number, y: number) => [...context.getImageData(x, y, 1, 1).data.slice(0, 3)]
    return { background: at(5, 5), box: at(90, 50), blue: at(230, 30), red: at(270, 30) }
  })
  const dark = await colours()
  expect(Math.max(...dark.background)).toBeLessThan(40)
  expect(Math.max(...dark.box)).toBeLessThan(120)
  // Its own colours, give or take (about 57,108,188 and 194,82,82): not
  // lightened to the sky blue and pink the dark filter alone makes.
  expect(Math.max(dark.blue[0], dark.blue[1])).toBeLessThan(130)
  expect(dark.blue[2]).toBeGreaterThan(150)
  expect(Math.max(dark.red[1], dark.red[2])).toBeLessThan(110)
  expect(dark.red[0]).toBeGreaterThan(150)
  // Back to light while it is open.
  await page.emulateMedia({ colorScheme: "light" })
  await expect.poll(async () => (await colours()).background).toEqual([255, 255, 255])
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
