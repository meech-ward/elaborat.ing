import { readFileSync } from "node:fs"
import path from "node:path"
import AxeBuilder from "./axe.ts"
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
  await page.getByRole("button", { name: "File actions" }).click()
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
  await expect(page.getByRole("tab", { name: "art/sketch.excalidraw, unsaved changes" })).toBeVisible()
  await page.keyboard.press("ControlOrMeta+s")
  await expect(status(page)).toContainText("Saved art/sketch.excalidraw.")
  await expect(page.getByRole("tab", { name: "art/sketch.excalidraw, unsaved changes" })).toHaveCount(0)
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
  await page.getByRole("group", { name: "Drawing view" }).getByRole("button", { name: "Code", exact: true }).click()
  const source = page.locator(".monaco-editor:visible .view-lines").first()
  await expect(source).toContainText("excalidraw-plugin: parsed")
  await page.getByRole("group", { name: "Drawing view" }).getByRole("button", { name: "Canvas", exact: true }).click()
  await expect(status(page)).toContainText("Saved")
  await page.waitForTimeout(1_000)
  expect(fake.server.content(id, "obsidian/system.excalidraw.md")).toBe(OBSIDIAN)

  // Breaking the file in the source view keeps the canvas's last valid scene.
  await page.getByRole("group", { name: "Drawing view" }).getByRole("button", { name: "Code", exact: true }).click()
  await source.click()
  await page.keyboard.press("ControlOrMeta+a")
  await page.keyboard.type("not a drawing")
  await page.getByRole("group", { name: "Drawing view" }).getByRole("button", { name: "Canvas", exact: true }).click()
  await expect(page.getByRole("alert").filter({ hasText: "This is not a valid drawing" })).toBeVisible()
  await expect(page.getByRole("group", { name: "Drawing view" }).getByRole("button", { name: "Code", exact: true })).toHaveAttribute("aria-pressed", "true")
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
  await page.getByRole("button", { name: "New file" }).click()
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
  await page.getByRole("button", { name: "Account and settings" }).click()
  await page.getByRole("menuitem", { name: "Sync now" }).click()
  await expect(status(page)).toContainText("2 elements")
  await expect(status(page)).toContainText("Saved")
  expect(fake.server.content(id, "sketch.excalidraw")).toBe(theirs)
})

// A drawing an agent adds to while it is open: a frame, then two solid boxes
// inside it, red at its own full opacity and blue at half.
const RED = "#e03131"
const BLUE = "#1971c2"
const box = (id: string, index: string, x: number, y: number, color: string, opacity = 100) => ({
  id, type: "rectangle", x, y, width: 160, height: 100, angle: 0, strokeColor: color, backgroundColor: color, fillStyle: "solid",
  strokeWidth: 2, strokeStyle: "solid", roughness: 0, opacity, groupIds: [], frameId: null, index, roundness: null, seed: 7,
  version: 1, versionNonce: 7, isDeleted: false, boundElements: [], updated: 1, link: null, locked: false,
})
const framed = (...boxes: object[]) =>
  `${JSON.stringify(
    {
      type: "excalidraw",
      version: 2,
      source: "https://excalidraw.com",
      elements: [{ ...box("frame", "a0", 0, 0, "#1e1e1e"), width: 420, height: 260, backgroundColor: "transparent" }, ...boxes],
      appState: { viewBackgroundColor: "#ffffff" },
      files: {},
    },
    null,
    2,
  )}\n`
const ADDED = framed(box("red", "a1", 30, 30, RED), box("blue", "a2", 230, 130, BLUE, 50))

/**
 * One frame of the open drawing: how opaque the canvas draws the red box and
 * the blue one (the alpha, 0 to 255, of the most opaque pixel of each); 1
 * when the drawing says it has unsaved changes; how each box shows in the
 * sketch over the canvas (0 not there, 1 there, 2 with one of its lines on
 * its way, 3 going once the canvas shows it); and where the sketch is drawn
 * (its scroll and zoom), if it is.
 */
type BoxFrame = [red: number, blue: number, unsaved: number, redSketch: number, blueSketch: number, sketchView: string]

/**
 * From now on, records every frame of the open drawing (BoxFrame), and each
 * time a box's sketch hands it to the canvas (it goes, or starts to go),
 * how the canvas draws the boxes then: before the page paints, so a frame
 * that would show neither is caught.
 */
async function watchBoxes(page: Page) {
  const rgb = (hex: string) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16))
  await page.evaluate(([red, blue]) => {
    const near = (data: Uint8ClampedArray, i: number, color: number[]) => color.every((value, at) => Math.abs(data[i + at] - value) < 16)
    const handovers: Array<[string, number, number]> = []
    Object.assign(window, { boxHandovers: handovers })
    const sketched = (id: string) => {
      const g = document.querySelector<SVGGElement>(`[data-sketch] [data-sketch-id="${id}"]`)
      if (!g || g.style.opacity === "0") return 0
      if (g.dataset.landed !== undefined) return 3
      const tracing = [...g.querySelectorAll("path")].some((path) =>
        path.getAnimations().some((animation) => {
          const effect = animation.effect as KeyframeEffect | null
          const progress = effect?.getComputedTiming().progress
          return typeof progress === "number" && progress > 0 && progress < 1 && "strokeDashoffset" in (effect?.getKeyframes()[0] ?? {})
        }),
      )
      return tracing ? 2 : 1
    }
    const frames: Array<[number, number, number, number, number, string]> = []
    Object.assign(window, { boxFrames: frames })
    const copy = document.createElement("canvas")
    const context = copy.getContext("2d", { willReadFrequently: true })!
    /** How opaque the canvas draws the red box and the blue one now; null before it shows. */
    const shownNow = () => {
      const canvas = document.querySelector<HTMLCanvasElement>(".excalidraw canvas.static")
      if (!canvas || canvas.width === 0) return null
      copy.width = Math.ceil(canvas.width / 4)
      copy.height = Math.ceil(canvas.height / 4)
      context.drawImage(canvas, 0, 0, copy.width, copy.height)
      const { data } = context.getImageData(0, 0, copy.width, copy.height)
      let [shownRed, shownBlue] = [0, 0]
      for (let i = 0; i < data.length; i += 4) {
        if (near(data, i, red)) shownRed = Math.max(shownRed, data[i + 3])
        else if (near(data, i, blue)) shownBlue = Math.max(shownBlue, data[i + 3])
      }
      return [shownRed, shownBlue]
    }
    const tick = () => {
      const shown = shownNow()
      if (shown) {
        const unsaved = document.querySelector(".wb-native-view [aria-live]")?.textContent?.includes("Unsaved changes")
        const view = document.querySelector("[data-sketch] > g")?.getAttribute("transform") ?? ""
        frames.push([shown[0], shown[1], unsaved ? 1 : 0, sketched("red"), sketched("blue"), view])
      }
      if (frames.length < 1_500) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    // A sketch going (or starting to) is seen right after the frame's work that did it, before the paint.
    new MutationObserver((records) => {
      for (const record of records) {
        const going = record.type === "attributes" ? [record.target] : [...record.removedNodes]
        for (const node of going) {
          const id = node instanceof SVGElement ? node.dataset.sketchId : undefined
          const shown = id ? shownNow() : null
          if (id && shown) handovers.push([id, shown[0], shown[1]])
        }
      }
    }).observe(document.querySelector("[data-slot='canvas-sketch']")!, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-landed"] })
  }, [rgb(RED), rgb(BLUE)])
}
/** Each time a box's sketch handed it to the canvas: the box, and how the canvas drew the red box and the blue one then. */
const boxHandovers = (page: Page) => page.evaluate(() => (window as unknown as { boxHandovers: Array<[string, number, number]> }).boxHandovers)
const boxFrames = (page: Page) => page.evaluate(() => (window as unknown as { boxFrames: BoxFrame[] }).boxFrames)
/** How the boxes are drawn on the canvas now: red's alpha, and blue's to the nearest 8. */
const boxesNow = async (page: Page) => {
  const [red, blue] = (await boxFrames(page)).at(-1) ?? [0, 0]
  return [red, Math.round(blue / 8) * 8]
}
/** The canvas alpha each box shows at in full: red's own, and blue's at half opacity. */
const FULL = { red: 250, blue: 120 }

async function agentAddsBoxes(page: Page) {
  const { fake, id } = await openProject(page, { "sketch.excalidraw": framed() }, "sketch.excalidraw")
  await expect(canvas(page)).toBeVisible()
  await expect(status(page)).toContainText("1 elements")
  const saves = saveCalls(fake)
  await watchBoxes(page)
  // The agent's save reaches the open drawing through Realtime.
  await fake.agentChanges.save(person.id, id, "sketch.excalidraw", ADDED)
  fake.signal(id, fake.server.projects.get(id)!.revision)
  await expect(status(page)).toContainText("3 elements")
  // Both end up drawn, each at its own opacity.
  await expect.poll(() => boxesNow(page)).toEqual([255, 128])
  return { fake, saves }
}

test("elements an agent adds to the open drawing are sketched in one after the other, each lands on the canvas when drawn, and the drawing stays saved with nothing to undo", async ({ page }) => {
  const { fake, saves } = await agentAddsBoxes(page)
  const frames = await boxFrames(page)
  // The blue box started after the red one.
  const redStarts = frames.findIndex((frame) => frame[3] > 0)
  const blueStarts = frames.findIndex((frame) => frame[4] > 0)
  expect(redStarts).toBeGreaterThanOrEqual(0)
  expect(blueStarts).toBeGreaterThan(redStarts)
  for (const [sketch, shown, full] of [[3, 0, FULL.red], [4, 1, FULL.blue]] as const) {
    const starts = frames.findIndex((frame) => frame[sketch] > 0)
    const onCanvas = frames.findIndex((frame) => frame[shown] > 0)
    expect(onCanvas).toBeGreaterThan(starts)
    // Its lines were drawn along their length over a canvas that showed none of it yet.
    expect(frames.slice(0, onCanvas).filter((frame) => frame[shown] > 0)).toEqual([])
    expect(frames.slice(starts, onCanvas).some((frame) => frame[sketch] === 2)).toBe(true)
    // In sight all along: in the sketch until the canvas showed it, then on the canvas in full.
    expect(frames.slice(starts, onCanvas).filter((frame) => frame[sketch] === 0 || frame[sketch] === 3)).toEqual([])
    expect(frames.slice(onCanvas).filter((frame) => frame[shown] < full)).toEqual([])
  }
  // When each sketch went, before the page painted again, the canvas already drew its box in full.
  const handovers = await boxHandovers(page)
  expect(handovers.filter(([id]) => id === "red").length).toBeGreaterThan(0)
  expect(handovers.filter(([id]) => id === "blue").length).toBeGreaterThan(0)
  expect(handovers.filter(([id, red, blue]) => (id === "red" && red < FULL.red) || (id === "blue" && blue < FULL.blue))).toEqual([])
  await expect(page.locator("[data-sketch]")).toHaveCount(0)
  // The sketch changed nothing of the file's: it never had unsaved changes, and has nothing to undo.
  expect(frames.filter(([, , unsaved]) => unsaved)).toEqual([])
  await expect(status(page)).toContainText("Saved")
  await expect(page.getByRole("tab", { name: "sketch.excalidraw, unsaved changes" })).toHaveCount(0)
  expect(saveCalls(fake)).toBe(saves)
  await page.getByRole("button", { name: "More tools" }).click()
  await expect(page.getByRole("menuitem", { name: "Undo" })).toBeDisabled()
})

test("with reduced motion, elements an agent adds to the open drawing appear at once, with no sketch", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await agentAddsBoxes(page)
  const frames = await boxFrames(page)
  // Both came in the same frame, in full, and nothing was sketched.
  expect(frames.findIndex(([red]) => red > 0)).toBe(frames.findIndex(([, blue]) => blue > 0))
  expect(frames.filter(([red, blue]) => (red > 0 && red < FULL.red) || (blue > 0 && blue < FULL.blue))).toEqual([])
  expect(frames.filter(([, , , redSketch, blueSketch]) => redSketch || blueSketch)).toEqual([])
  await expect(page.getByRole("button", { name: "Pencil sound" })).toHaveCount(0)
})

test("when the person starts working on the canvas while elements are sketched in, the rest shows at once", async ({ page }) => {
  const { fake, id } = await openProject(page, { "sketch.excalidraw": framed() }, "sketch.excalidraw")
  await expect(canvas(page)).toBeVisible()
  await expect(status(page)).toContainText("1 elements")
  const saves = saveCalls(fake)
  await watchBoxes(page)
  await fake.agentChanges.save(person.id, id, "sketch.excalidraw", ADDED)
  fake.signal(id, fake.server.projects.get(id)!.revision)
  // As the red box is sketched, before the blue one is on the canvas, the person presses on an empty spot below the frame.
  await expect.poll(async () => (await boxFrames(page)).at(-1)?.[3], { intervals: [16] }).toBeGreaterThan(0)
  expect((await boxFrames(page)).filter(([, blue]) => blue > 0)).toEqual([])
  const area = (await canvas(page).boundingBox())!
  await page.mouse.click(area.x + area.width / 2, area.y + area.height / 2 + 200)
  const pressed = (await boxFrames(page)).length
  // Both are on the canvas in full within a frame or two, and the sketch is gone.
  await expect.poll(async () => (await boxFrames(page)).length).toBeGreaterThan(pressed + 10)
  const after = (await boxFrames(page)).slice(pressed + 2)
  expect(after.filter(([red, blue, , redSketch, blueSketch]) => red < FULL.red || blue < FULL.blue || redSketch || blueSketch)).toEqual([])
  await expect(page.locator("[data-sketch]")).toHaveCount(0)
  expect((await boxFrames(page)).filter(([, , unsaved]) => unsaved)).toEqual([])
  expect(saveCalls(fake)).toBe(saves)
  await page.getByRole("button", { name: "More tools" }).click()
  await expect(page.getByRole("menuitem", { name: "Undo" })).toBeDisabled()
})

test("a sketch makes a pencil stroke for its elements where the browser lets audio play, and the person can mute it for the next ones", async ({ page }) => {
  const { fake, id } = await openProject(page, { "sketch.excalidraw": framed() }, "sketch.excalidraw")
  await expect(canvas(page)).toBeVisible()
  await expect(status(page)).toContainText("1 elements")
  // Counts the strokes the page starts, and finds out whether this browser lets it play audio unasked.
  const audible = await page.evaluate(async () => {
    const state = window as unknown as { strokes: number }
    state.strokes = 0
    const start = AudioBufferSourceNode.prototype.start
    AudioBufferSourceNode.prototype.start = function (this: AudioBufferSourceNode, ...args: Parameters<AudioBufferSourceNode["start"]>) {
      state.strokes++
      return start.apply(this, args)
    }
    const probe = new AudioContext()
    await Promise.race([probe.resume(), new Promise((resolve) => setTimeout(resolve, 300))])
    const running = probe.state === "running"
    await probe.close()
    return running
  })
  const strokes = () => page.evaluate(() => (window as unknown as { strokes: number }).strokes)
  await watchBoxes(page)
  await fake.agentChanges.save(person.id, id, "sketch.excalidraw", ADDED)
  fake.signal(id, fake.server.projects.get(id)!.revision)
  // On by default while the boxes are sketched in; where the browser holds audio back, silent.
  const sound = page.getByRole("button", { name: "Pencil sound" })
  await expect(sound).toHaveAttribute("aria-pressed", "true")
  await expect.poll(() => boxesNow(page)).toEqual([255, 128])
  await expect(sound).toHaveCount(0)
  if (audible) expect(await strokes()).toBeGreaterThan(0)
  else expect(await strokes()).toBe(0)

  // Muted while the next ones are sketched in, the rest of them come in silence, and it stays muted.
  const more = framed(box("red", "a1", 30, 30, RED), box("blue", "a2", 230, 130, BLUE, 50), box("green", "a3", 30, 300, "#2f9e44"), box("plum", "a4", 230, 300, "#9c36b5"))
  await fake.agentChanges.save(person.id, id, "sketch.excalidraw", more)
  fake.signal(id, fake.server.projects.get(id)!.revision)
  await sound.click()
  await expect(sound).toHaveAttribute("aria-pressed", "false")
  const muted = await strokes()
  // The button is not the canvas: the sketch went on.
  await expect(page.locator("[data-sketch]")).toHaveCount(1)
  await expect(sound).toHaveCount(0, { timeout: 15_000 })
  expect(await strokes()).toBe(muted)
  expect(await page.evaluate(() => localStorage.getItem("elaborat.ing:pencil-sound"))).toBe("off")
  await expect(status(page)).toContainText("5 elements")
})

/** Open the frame on its own, watch the canvas, and have the agent add the red box far to its right, out of sight. */
async function agentAddsBoxOutOfSight(page: Page, beforeTheAgent?: () => Promise<void>) {
  const { fake, id } = await openProject(page, { "sketch.excalidraw": framed() }, "sketch.excalidraw")
  await expect(canvas(page)).toBeVisible()
  await expect(status(page)).toContainText("1 elements")
  await expect(page.getByRole("button", { name: "Reset zoom, now 100%" })).toBeVisible()
  const saves = saveCalls(fake)
  await watchBoxes(page)
  await beforeTheAgent?.()
  await fake.agentChanges.save(person.id, id, "sketch.excalidraw", framed(box("red", "a1", 2400, 80, RED)))
  fake.signal(id, fake.server.projects.get(id)!.revision)
  await expect(status(page)).toContainText("2 elements")
  return { fake, saves }
}

test("the open drawing moves to an element an agent adds out of sight, at the same zoom, then sketches it in, with nothing to save or undo", async ({ page }) => {
  const { fake, saves } = await agentAddsBoxOutOfSight(page)
  // The view went to the red box: it shows, all drawn in, and nothing was zoomed.
  await expect.poll(() => boxesNow(page)).toEqual([255, 0])
  await expect(page.getByRole("button", { name: "Reset zoom, now 100%" })).toBeVisible()
  // The view moved first, and stayed where it went while the box was sketched.
  const frames = await boxFrames(page)
  const starts = frames.findIndex(([, , , redSketch]) => redSketch > 0)
  expect(new Set(frames.slice(0, starts).map(([, , , , , view]) => view).filter(Boolean)).size).toBeGreaterThan(1)
  expect(new Set(frames.slice(starts).map(([, , , , , view]) => view).filter(Boolean)).size).toBe(1)
  expect((await boxFrames(page)).filter(([, , unsaved]) => unsaved)).toEqual([])
  await expect(status(page)).toContainText("Saved")
  expect(saveCalls(fake)).toBe(saves)
  await page.getByRole("button", { name: "More tools" }).click()
  await expect(page.getByRole("menuitem", { name: "Undo" })).toBeDisabled()
})

test("a drawing the person has just moved stays where they put it when an agent adds an element out of sight", async ({ page }) => {
  await agentAddsBoxOutOfSight(page, async () => {
    // The person scrolls the view down a little with the mouse wheel.
    const area = (await canvas(page).boundingBox())!
    await page.mouse.move(area.x + area.width / 2, area.y + area.height / 2)
    await page.mouse.wheel(0, 120)
  })
  // A second's worth of frames after it arrived, and the red box never came into view.
  const arrived = (await boxFrames(page)).length
  await expect.poll(async () => (await boxFrames(page)).length).toBeGreaterThan(arrived + 60)
  expect((await boxFrames(page)).filter(([red]) => red > 0)).toEqual([])
})

test("on a desktop the canvas fills the window behind the panels, and the side panel keeps its own clicks", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  const { fake, id } = await openProject(page, { "sketch.excalidraw": SCENE }, "sketch.excalidraw")
  await expect(canvas(page)).toBeVisible()
  await expect.poll(() => canvas(page).boundingBox()).toEqual({ x: 0, y: 0, width: 1280, height: 800 })

  // The tool island stands in for Excalidraw's own toolbar and footer, and
  // the drawing opens at 100%.
  await expect(page.locator(".App-toolbar")).toBeHidden()
  await expect(page.locator(".zoom-actions")).toBeHidden()
  await expect(page.getByRole("button", { name: "Reset zoom, now 100%" })).toBeVisible()
  // The island's rectangle picks Excalidraw's tool, pressed in the palette's selected-tool colour.
  const rectangle = page.getByRole("group", { name: "Drawing tools" }).getByRole("button", { name: "Rectangle" })
  await rectangle.click()
  await expect(rectangle).toHaveAttribute("aria-pressed", "true")
  const scheme = await page.evaluate(() => (document.documentElement.dataset.scheme === "light" ? "light" : "dark"))
  const rgb = (hex: string) => `rgb(${[1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)).join(", ")})`
  await expect(rectangle).toHaveCSS("background-color", rgb(palettes[0][scheme].toolOn))

  // A drag over the side panel stays there and draws nothing.
  const files = (await page.getByRole("navigation", { name: "Workspace files" }).boundingBox())!
  const [x, y] = [files.x + files.width / 2, files.y + files.height - 60]
  expect(await page.evaluate(([x, y]) => Boolean(document.elementFromPoint(x, y)?.closest('nav[aria-label="Workspace files"]')), [x, y])).toBe(true)
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
  // Excalidraw's selection tool is current again after the shape.
  await expect(page.getByRole("group", { name: "Drawing tools" }).getByRole("button", { name: "Select" })).toHaveAttribute("aria-pressed", "true")

  // Undo and redo are in More tools.
  await page.getByRole("button", { name: "More tools" }).click()
  await page.getByRole("menuitem", { name: "Undo" }).click()
  await expect(status(page)).toContainText("1 elements")
  await page.getByRole("button", { name: "More tools" }).click()
  await page.getByRole("menuitem", { name: "Redo" }).click()
  await expect(status(page)).toContainText("2 elements")
  // Keep tool active is a checkbox there, and turns Excalidraw's tool lock on.
  await page.getByRole("button", { name: "More tools" }).click()
  await page.getByRole("menuitemcheckbox", { name: "Keep tool active" }).click()
  await page.getByRole("button", { name: "More tools" }).click()
  await expect(page.getByRole("menuitemcheckbox", { name: "Keep tool active" })).toHaveAttribute("aria-checked", "true")
  await page.keyboard.press("Escape")

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
    await expect(page.locator('[data-slot="phone-header"]').getByRole("button", { name: "File actions" })).toBeVisible()
    const results = await new AxeBuilder({ page }).include('[data-slot="phone-header"]').analyze()
    expect(results.violations.map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => node.target) }))).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
    const box = await canvas(page).boundingBox()
    expect(box && box.width <= 390 && box.height > 200).toBe(true)
    // The touch-sized tool island at the bottom stands in for Excalidraw's own toolbar.
    await expect(page.locator(".App-top-bar")).toBeHidden()
    const island = (await page.getByRole("group", { name: "Drawing tools" }).boundingBox())!
    expect(island.y + island.height).toBeGreaterThan(844 - 90)
    expect(Math.abs(island.x + island.width / 2 - 195)).toBeLessThan(40)
  })
})
