import { expect, test, type Page } from "@playwright/test"
import { FakeProjectServer } from "../../src/features/project-storage/fakeServer.ts"
import { fakeSupabase, person, signedIn, type FakeSupabase } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

// Comments on a drawing's elements: with one element selected, Comment in
// More tools, in Excalidraw's menu for the element or on the comment key
// starts a thread on it, at the spot it was pointed at. Each open thread
// shows as a pin on its element, which follows the view and the element as
// it moves; a pin opens the panel at its thread, and the panel's Go to shows
// the element. A deleted element's thread is detached. A D2 diagram's
// element comments hang on its generated canvas, whose element ids stay
// through Regenerate.

test.describe.configure({ timeout: 90_000 })

const PATH = "art/flow.excalidraw"
const SOMEONE_ELSE = "5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f"

const element = (fields: Record<string, unknown>) => ({
  angle: 0,
  strokeColor: "#1e1e1e",
  backgroundColor: "transparent",
  fillStyle: "solid",
  strokeWidth: 2,
  strokeStyle: "solid",
  roughness: 1,
  opacity: 100,
  groupIds: [],
  frameId: null,
  roundness: null,
  seed: 1,
  version: 1,
  versionNonce: 1,
  isDeleted: false,
  boundElements: [],
  updated: 1,
  link: null,
  locked: false,
  ...fields,
})

// A filled box labelled "Sign up" (0,0 to 200,100) and a filled ellipse (320,0 to 480,100).
const SCENE = `${JSON.stringify(
  {
    type: "excalidraw",
    version: 2,
    source: "https://excalidraw.com",
    elements: [
      element({ id: "box-1", type: "rectangle", x: 0, y: 0, width: 200, height: 100, backgroundColor: "#a5d8ff", index: "a0", boundElements: [{ id: "box-1-label", type: "text" }] }),
      element({
        id: "box-1-label",
        type: "text",
        x: 60,
        y: 37.5,
        width: 80,
        height: 25,
        index: "a1",
        text: "Sign up",
        originalText: "Sign up",
        fontSize: 20,
        fontFamily: 5,
        textAlign: "center",
        verticalAlign: "middle",
        containerId: "box-1",
        lineHeight: 1.25,
        autoResize: true,
      }),
      element({ id: "idea", type: "ellipse", x: 320, y: 0, width: 160, height: 100, backgroundColor: "#ffec99", index: "a2" }),
    ],
    appState: { viewBackgroundColor: "#ffffff" },
    files: {},
  },
  null,
  2,
)}\n`
/** The middle of the scene's elements, which the canvas opens in the middle of its visible area. */
const MIDDLE = { x: 240, y: 50 }

const panel = (page: Page) => page.getByRole("complementary", { name: "Comments" })
const thread = (page: Page, name: string) => panel(page).getByRole("article", { name: `Comments on ${name}` })
const pin = (page: Page, name: string) => page.getByRole("button", { name, exact: true })
const moreTools = (page: Page) => page.getByRole("button", { name: "More tools" })

/**
 * Opens the comments panel. The canvas area ends at the panel, so the scene
 * moves to keep its middle there: places are measured once it is open.
 */
async function openPanel(page: Page) {
  await page.getByRole("button", { name: /^Comments/ }).first().click()
  await expect(panel(page)).toBeVisible()
  const area = page.locator('[data-slot="canvas-controls"]')
  await expect.poll(async () => {
    const box = (await area.boundingBox())!
    const aside = (await panel(page).boundingBox())!
    return Math.round(box.x + box.width - aside.x)
  }).toBe(0)
}

/** Writes a new comment in the panel's draft and sends it. */
async function send(page: Page, body: string) {
  const field = panel(page).getByRole("textbox", { name: "New comment" })
  await expect(field).toBeFocused()
  await field.fill(body)
  await field.press("ControlOrMeta+Enter")
}

/** The canvas's zoom, from the zoom island. */
async function zoom(page: Page) {
  const reset = await page.getByRole("button", { name: /^Reset zoom, now \d+%$/ }).getAttribute("aria-label")
  return Number(/(\d+)%/.exec(reset!)![1]) / 100
}

/**
 * Where a scene point is on screen while the canvas is as it opened: the
 * middle of the scene in the middle of the visible canvas area (the canvas
 * controls' layer), at the zoom the island shows.
 */
async function onScreen(page: Page, point: { x: number; y: number }, middle = MIDDLE) {
  const area = (await page.locator('[data-slot="canvas-controls"]').boundingBox())!
  const scale = await zoom(page)
  return { x: area.x + area.width / 2 + (point.x - middle.x) * scale, y: area.y + area.height / 2 + (point.y - middle.y) * scale }
}

/** A pin's point: its bottom-left corner. */
async function pinPoint(page: Page, name: string) {
  const box = (await pin(page, name).boundingBox())!
  return { x: box.x, y: box.y + box.height }
}

const near = (actual: { x: number; y: number }, expected: { x: number; y: number }) => {
  expect(Math.abs(actual.x - expected.x), `x ${actual.x} is near ${expected.x}`).toBeLessThan(3)
  expect(Math.abs(actual.y - expected.y), `y ${actual.y} is near ${expected.y}`).toBeLessThan(3)
}

/** A project with the drawing, opened on its canvas, with a thread on the box when `thread` is set. */
async function seeded(page: Page, { thread: opening, role }: { thread?: Record<string, unknown>; role?: "viewer" | "commenter" } = {}): Promise<{ fake: FakeSupabase; id: string }> {
  const server = new FakeProjectServer()
  const owner = role ? SOMEONE_ELSE : person.id
  const remote = server.remote(owner)
  const id = crypto.randomUUID()
  await remote.createProject(id, "Sketches")
  await remote.saveFiles(id, crypto.randomUUID(), [{ op: "put", path: PATH, content: SCENE }])
  if (role) server.share(id, person.id, role)
  const fake = await fakeSupabase(page, { server })
  const fileId = [...fake.server.projects.get(id)!.files.values()].find((file) => file.path === PATH)!.id
  if (opening) fake.comments.call(owner, "add_comment", { project_id: id, thread_id: crypto.randomUUID(), file_id: fileId, file_version: 1, anchor: opening, body: "Should this say Create account?" })
  await signedIn(page)
  await page.goto(new URL(`projects/${id}/${PATH}`, APP_URL).href)
  await expect(page.getByRole("tabpanel", { name: PATH })).toBeVisible({ timeout: 15_000 })
  await expect(page.locator(".excalidraw canvas").first()).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole("button", { name: /^Reset zoom, now \d+%$/ })).toBeVisible()
  return { fake, id }
}

test("a shape is commented on from More tools at the spot clicked, its pin opens the thread, and Go to shows the shape", async ({ page }) => {
  const { fake } = await seeded(page)
  await openPanel(page)
  // Comment waits for one element to be selected.
  await moreTools(page).click()
  await expect(page.getByRole("menuitem", { name: /^Comment/ })).toBeDisabled()
  await page.keyboard.press("Escape")

  const spot = await onScreen(page, { x: 50, y: 50 })
  await page.mouse.click(spot.x, spot.y)
  await moreTools(page).click()
  await page.getByRole("menuitem", { name: /^Comment/ }).click()
  await expect(panel(page).getByRole("article", { name: "New comment on Sign up" })).toBeVisible()
  await expect(pin(page, "New comment on Sign up")).toBeVisible()
  await send(page, "Should this say Create account?")
  await expect(thread(page, "Sign up").getByText("Should this say Create account?")).toBeVisible()
  expect(fake.comments.threads.map((entry) => entry.anchor)).toEqual([
    { kind: "element", element_id: "box-1", label: "Sign up", point: { x: expect.closeTo(0.25, 1), y: expect.closeTo(0.5, 1) } },
  ])

  // The pin marks the spot clicked, with its bottom-left corner.
  near(await pinPoint(page, "1 thread on Sign up"), spot)
  await expect(pin(page, "1 thread on Sign up")).toHaveAttribute("data-active", "true")

  // The pin opens the panel at its thread and gives it the keyboard.
  await panel(page).getByRole("button", { name: "Close comments" }).click()
  await expect(panel(page)).toBeHidden()
  await pin(page, "1 thread on Sign up").click()
  await expect(thread(page, "Sign up")).toBeFocused()

  // Go to brings the shape to the middle of the canvas: the spot is 50 left of the box's middle.
  await page.getByRole("button", { name: "Zoom in" }).click()
  await page.getByRole("button", { name: "Zoom in" }).click()
  const scale = await zoom(page)
  await thread(page, "Sign up").getByRole("button", { name: /Sign up/ }).first().click()
  const area = (await page.locator('[data-slot="canvas-controls"]').boundingBox())!
  near(await pinPoint(page, "1 thread on Sign up"), { x: area.x + area.width / 2 - 50 * scale, y: area.y + area.height / 2 })
})

test("Excalidraw's menu for an element comments on it, where it was opened, and so does the comment key", async ({ page }) => {
  const { fake } = await seeded(page)
  await openPanel(page)
  const spot = await onScreen(page, { x: 400, y: 75 })
  await page.mouse.click(spot.x, spot.y, { button: "right" })
  const menu = page.locator(".excalidraw .context-menu")
  await menu.getByRole("button", { name: /^Comment/ }).click()
  await expect(menu).toHaveCount(0)
  await send(page, "Is this the next step?")
  await expect(thread(page, "Ellipse")).toBeVisible()
  near(await pinPoint(page, "1 thread on Ellipse"), spot)

  // The comment key on the selected box: a pin at the spot it was clicked
  // (clear of the ellipse's properties, which stay until the click).
  const onBox = await onScreen(page, { x: 180, y: 80 })
  await page.mouse.click(onBox.x, onBox.y)
  await page.keyboard.press("ControlOrMeta+Alt+m")
  await send(page, "Make it bigger.")
  await expect(thread(page, "Sign up")).toBeVisible()
  expect(fake.comments.threads.map((entry) => entry.anchor)).toEqual([
    { kind: "element", element_id: "idea", label: "ellipse", point: { x: expect.closeTo(0.5, 1), y: expect.closeTo(0.75, 1) } },
    { kind: "element", element_id: "box-1", label: "Sign up", point: { x: expect.closeTo(0.9, 1), y: expect.closeTo(0.8, 1) } },
  ])
})

test("a pin follows the view and its shape as it moves, and a deleted shape's thread is detached", async ({ page }) => {
  await seeded(page, { thread: { kind: "element", element_id: "box-1", label: "Sign up" } })
  const name = "1 thread on Sign up"
  // Without a spot, the pin sits at the box's top-right corner.
  near(await pinPoint(page, name), await onScreen(page, { x: 200, y: 0 }))

  // Zooming in keeps the middle of the area where it is: the pin moves away from it.
  const area = (await page.locator('[data-slot="canvas-controls"]').boundingBox())!
  const middle = { x: area.x + area.width / 2, y: area.y + area.height / 2 }
  const before = await pinPoint(page, name)
  await page.getByRole("button", { name: "Zoom in" }).click()
  const scale = await zoom(page)
  near(await pinPoint(page, name), { x: middle.x + (before.x - middle.x) * scale, y: middle.y + (before.y - middle.y) * scale })

  // Dragging the box moves its pin with it.
  const start = await pinPoint(page, name)
  const grab = { x: start.x - 170 * scale, y: start.y + 30 * scale }
  await page.mouse.move(grab.x, grab.y)
  await page.mouse.down()
  await page.mouse.move(grab.x + 120, grab.y + 60, { steps: 8 })
  await page.mouse.up()
  near(await pinPoint(page, name), { x: start.x + 120, y: start.y + 60 })

  // Deleting the box takes its pin away; the panel shows its thread detached, with its label.
  await page.keyboard.press("Delete")
  await expect(pin(page, name)).toHaveCount(0)
  await page.getByRole("button", { name: /^Comments/ }).first().click()
  const detached = thread(page, "Sign up")
  await expect(detached).toContainText("Detached")
  await expect(detached).toContainText("Should this say Create account?")
})

test("Go to from Code shows the canvas, with the element in the middle", async ({ page }) => {
  await seeded(page, { thread: { kind: "element", element_id: "idea", label: "ellipse" } })
  await openPanel(page)
  await page.getByRole("group", { name: "Drawing view" }).getByRole("button", { name: "Code", exact: true }).click()
  await expect(pin(page, "1 thread on Ellipse")).toBeHidden()
  await thread(page, "Ellipse").getByRole("button", { name: "Go to Ellipse" }).click()
  await expect(page.getByRole("group", { name: "Drawing view" }).getByRole("button", { name: "Canvas", exact: true })).toHaveAttribute("aria-pressed", "true")
  // The ellipse's middle (400, 50) is in the middle of the canvas area: its pin, at its top-right corner, is 80 right and 50 up of it.
  const area = (await page.locator('[data-slot="canvas-controls"]').boundingBox())!
  await expect.poll(async () => {
    const at = await pinPoint(page, "1 thread on Ellipse")
    const scale = await zoom(page)
    return Math.round(Math.abs(at.x - (area.x + area.width / 2 + 80 * scale)) + Math.abs(at.y - (area.y + area.height / 2 - 50 * scale)))
  }).toBeLessThan(4)
})

test("a viewer sees the pins, and is offered no Comment", async ({ page }) => {
  await seeded(page, { thread: { kind: "element", element_id: "box-1", label: "Sign up" }, role: "viewer" })
  await expect(pin(page, "1 thread on Sign up")).toBeVisible()
  const spot = await onScreen(page, { x: 400, y: 75 })
  await page.mouse.click(spot.x, spot.y, { button: "right" })
  await expect(page.locator(".excalidraw .context-menu")).toBeVisible()
  await expect(page.locator(".excalidraw .context-menu").getByRole("button", { name: /^Comment/ })).toHaveCount(0)
})

test("a commenter, whose canvas has no tools, selects a shape with a click and comments on it from the Comment button, the key and Excalidraw's menu", async ({ page }) => {
  const { fake } = await seeded(page, { role: "commenter" })
  await openPanel(page)
  await expect(moreTools(page)).toHaveCount(0)
  const comment = page.locator('[data-slot="selected-element-comment"]')
  await expect(comment).toHaveCount(0)

  // A click on the box selects it: the Comment button shows above it and starts the comment at the spot clicked.
  const spot = await onScreen(page, { x: 50, y: 50 })
  await page.mouse.click(spot.x, spot.y)
  await expect(comment).toBeVisible()
  const top = await onScreen(page, { x: 100, y: 0 })
  const button = (await comment.boundingBox())!
  expect(button.y + button.height).toBeLessThan(top.y)
  expect(Math.abs(button.x + button.width / 2 - top.x)).toBeLessThan(3)
  await comment.click()
  await send(page, "Should this say Create account?")
  await expect(thread(page, "Sign up")).toBeVisible()
  near(await pinPoint(page, "1 thread on Sign up"), spot)

  // A click on empty canvas selects nothing, and a drag still pans.
  const empty = await onScreen(page, { x: 260, y: 200 })
  await page.mouse.click(empty.x, empty.y)
  await expect(comment).toHaveCount(0)

  // The comment key on the clicked ellipse.
  const onIdea = await onScreen(page, { x: 400, y: 50 })
  await page.mouse.click(onIdea.x, onIdea.y)
  await expect(comment).toBeVisible()
  await page.keyboard.press("ControlOrMeta+Alt+m")
  await send(page, "Is this the next step?")
  await expect(thread(page, "Ellipse")).toBeVisible()

  // Excalidraw's menu for the box, though view mode lets go of the selection when the button comes up.
  const onBox = await onScreen(page, { x: 20, y: 80 })
  await page.mouse.click(onBox.x, onBox.y, { button: "right" })
  const menu = page.locator(".excalidraw .context-menu")
  await menu.getByRole("button", { name: /^Comment/ }).click()
  await send(page, "Make it bigger.")
  expect(fake.comments.threads.map((entry) => ({ element: (entry.anchor as { element_id: string }).element_id, author: entry.createdBy }))).toEqual([
    { element: "box-1", author: person.id },
    { element: "idea", author: person.id },
    { element: "box-1", author: person.id },
  ])
})

test("in Split beside the comments panel, the canvas's tools and pins keep to the canvas left of the panel", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await seeded(page, { thread: { kind: "element", element_id: "idea", label: "ellipse" } })
  await page.getByRole("group", { name: "Drawing view" }).getByRole("button", { name: "Split", exact: true }).click()
  await openPanel(page)
  const area = (await page.locator('[data-slot="canvas-controls"]').boundingBox())!
  // The island fits in the narrow area: More tools is on screen, clear of the panel, and takes a click.
  const island = (await page.locator('[data-slot="canvas-island"]').filter({ has: moreTools(page) }).boundingBox())!
  expect(island.x).toBeGreaterThanOrEqual(area.x)
  expect(island.x + island.width).toBeLessThanOrEqual(area.x + area.width)
  await moreTools(page).click()
  await expect(page.getByRole("menuitem", { name: /^Comment/ })).toBeVisible()
  await page.keyboard.press("Escape")
  // Tools that do not fit are in More tools.
  await moreTools(page).click()
  await expect(page.getByRole("menuitem", { name: "Text" })).toBeVisible()
  await page.keyboard.press("Escape")
  // Pins show only on the visible canvas: none past the area's right edge.
  for (const box of await page.locator('[data-slot="canvas-comments"] [data-pin]').evaluateAll((pins) => pins.map((entry) => entry.getBoundingClientRect().toJSON() as DOMRect))) {
    const shown = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("[data-pin]") !== null, { x: box.x + box.width / 2, y: box.y + box.height / 2 })
    if (box.x > area.x + area.width) expect(shown).toBe(false)
  }
})

test("a comment on a diagram node hangs on its generated canvas and stays on the node through Regenerate", async ({ page }) => {
  const fake = await fakeSupabase(page)
  const id = crypto.randomUUID()
  const remote = fake.server.remote(person.id)
  await remote.createProject(id, "Diagrams")
  await remote.saveFiles(id, crypto.randomUUID(), [{ op: "put", path: "flow.d2", content: "a -> b\n" }])
  await signedIn(page)
  await page.goto(new URL(`projects/${id}/flow.d2`, APP_URL).href)
  await expect(page.getByText("Compiling diagram…")).toHaveCount(0, { timeout: 45_000 })
  // Opening saves the generated canvas, which element comments hang on.
  await expect(page.locator(".wb-native-view [aria-live]").first()).toContainText("Saved flow.d2 and its generated files.", { timeout: 30_000 })
  await expect.poll(() => fake.server.content(id, "flow.excalidraw")).toBeDefined()

  type SceneElement = { id: string; x: number; y: number; width: number; height: number; isDeleted?: boolean; points?: [number, number][] }
  const elements = (JSON.parse(fake.server.content(id, "flow.excalidraw")!) as { elements: SceneElement[] }).elements.filter((entry) => !entry.isDeleted)
  const extent = (entry: SceneElement) => {
    const xs = entry.points ? entry.points.map(([x]) => entry.x + x) : [entry.x, entry.x + entry.width]
    const ys = entry.points ? entry.points.map(([, y]) => entry.y + y) : [entry.y, entry.y + entry.height]
    return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) }
  }
  const all = elements.map(extent)
  const middle = { x: (Math.min(...all.map((e) => e.x1)) + Math.max(...all.map((e) => e.x2))) / 2, y: (Math.min(...all.map((e) => e.y1)) + Math.max(...all.map((e) => e.y2))) / 2 }
  const node = extent(elements.find((entry) => entry.id === "d2:a")!)
  const spot = await onScreen(page, { x: node.x1 + 10, y: (node.y1 + node.y2) / 2 }, middle)
  await page.mouse.click(spot.x, spot.y)
  await moreTools(page).click()
  await page.getByRole("menuitem", { name: /^Comment/ }).click()
  await send(page, "Rename this step.")
  await expect(thread(page, "a")).toBeVisible()
  const canvasId = fake.server.projects.get(id)!.files.get("flow.excalidraw")!.id
  expect(fake.comments.threads.map(({ fileId, anchor }) => ({ fileId, anchor }))).toMatchObject([
    { fileId: canvasId, anchor: { kind: "element", element_id: "d2:a", label: "a" } },
  ])
  await expect(pin(page, "1 thread on a")).toBeVisible()

  // A code change, and Regenerate: the node keeps its id, so its pin and thread stay.
  await page.getByRole("group", { name: "Diagram view" }).getByRole("button", { name: "Code", exact: true }).click()
  await page.locator(".monaco-editor:visible .view-lines").first().click()
  await page.keyboard.press("ControlOrMeta+End")
  await page.keyboard.type("b -> c\n")
  await page.getByRole("button", { name: "File actions" }).click()
  await page.getByRole("menuitem", { name: "Regenerate" }).click()
  await expect(page.locator(".wb-native-view [aria-live]").first()).toContainText("Regenerated", { timeout: 30_000 })
  await page.getByRole("group", { name: "Diagram view" }).getByRole("button", { name: "Canvas", exact: true }).click()
  await expect(pin(page, "1 thread on a")).toBeVisible()
  await expect(thread(page, "a")).not.toContainText("Detached")
  await expect(thread(page, "a")).toContainText("Rename this step.")
})
