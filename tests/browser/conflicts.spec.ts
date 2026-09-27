import AxeBuilder from "./axe.ts"
import { expect, test, type Page } from "@playwright/test"
import { palettes } from "../../src/features/appearance/palettes.ts"
import { fakeSupabase, person, signedIn, type FakeSupabase } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

// A file changed on this device and on the server stops syncing and asks
// which version to keep. Compare shows what differs first: a diff for text,
// pictures for drawings, with the same choices.

const projectUrl = (id: string, file?: string) => new URL(`projects/${id}${file ? `/${file}` : ""}`, APP_URL).href

test.describe.configure({ timeout: 60_000 })

const NOTE = "# Plan\n\nShared line\n"

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

/** The same drawing as changed on the server: the box moved, and an ellipse added. */
function serverScene(): string {
  const scene = JSON.parse(SCENE)
  const box = scene.elements[0]
  scene.elements = [
    { ...box, x: 60, version: 2, versionNonce: 2 },
    { ...box, id: "oval-1", type: "ellipse", x: 0, y: 160, index: "a1", seed: 2 },
  ]
  return `${JSON.stringify(scene, null, 2)}\n`
}

async function openProject(page: Page, files: Record<string, string>, file: string, phone = false) {
  const fake = await fakeSupabase(page)
  const remote = fake.server.remote(person.id)
  const id = crypto.randomUUID()
  await remote.createProject(id, "Conflicts")
  for (const [name, content] of Object.entries(files)) await remote.saveFiles(id, crypto.randomUUID(), [{ op: "put", path: name, content }])
  await signedIn(page)
  await page.goto(projectUrl(id, file))
  // A phone shows no sync status; the file opens once the project is on the device.
  if (phone) await expect(page.locator(".monaco-editor:visible .view-lines").first()).toContainText("Shared line", { timeout: 15_000 })
  else await expect(page.getByRole("status").filter({ hasText: "Synced" })).toBeVisible({ timeout: 15_000 })
  return { fake, id }
}

/** Change or delete `path` on the server, as another device would. */
async function changeOnServer(fake: FakeSupabase, id: string, path: string, content: string | null) {
  const version = fake.server.projects.get(id)!.files.get(path)!.version
  await fake.server
    .remote(person.id)
    .saveFiles(id, crypto.randomUUID(), [content === null ? { op: "delete", path, base_version: version } : { op: "put", path, content, base_version: version }])
}

/** Come back online, so sync sends this device's save and finds the conflict. */
async function reconnect(page: Page, fake: FakeSupabase) {
  fake.offline = false
  await page.evaluate(() => window.dispatchEvent(new Event("online")))
  await expect(page.getByRole("alert").filter({ hasText: "was changed on another device too" })).toBeVisible({ timeout: 15_000 })
}

/** Save "My line" as the note's last line on this device, while offline. */
async function saveMyLine(page: Page, fake: FakeSupabase) {
  fake.offline = true
  await page.locator(".monaco-editor:visible .view-lines").first().click()
  await page.keyboard.press("ControlOrMeta+End")
  await page.keyboard.type("My line")
  await page.keyboard.press("ControlOrMeta+s")
  await expect(page.getByRole("tab", { name: "a.md" }).getByLabel("unsaved changes")).toHaveCount(0)
}

async function expectNoAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page }).include(".wb-compare").analyze()
  expect(results.violations.map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => node.target) }))).toEqual([])
}

test("Compare shows a note's two versions as a diff, and Keep mine from there resolves it", async ({ page }) => {
  const { fake, id } = await openProject(page, { "a.md": NOTE }, "a.md")
  await saveMyLine(page, fake)
  await changeOnServer(fake, id, "a.md", `${NOTE}Their line\n`)
  await reconnect(page, fake)

  await page.getByRole("button", { name: "Compare" }).click()
  const dialog = page.getByRole("dialog", { name: "Compare a.md" })
  await expect(dialog.locator(".editor.original .view-lines")).toContainText("Their line")
  await expect(dialog.locator(".editor.modified .view-lines")).toContainText("My line")
  await expect(dialog.getByText("On the server", { exact: true })).toBeVisible()
  await expect(dialog.getByText("On this device", { exact: true })).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused()
  await expectNoAxeViolations(page)

  await dialog.getByRole("button", { name: "Keep mine" }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByText("Keeping your version.")).toBeVisible()
  await expect(page.getByRole("alert").filter({ hasText: "was changed on another device too" })).toHaveCount(0)
  await expect.poll(() => fake.server.content(id, "a.md")).toContain("My line")
  expect(fake.server.content(id, "a.md")).not.toContain("Their line")
})

test("in Cherry Paper light, the conflict banner has the palette's warning background", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("elaborating.appearance.v1", JSON.stringify({ theme: "cherry-paper", mode: "light" })))
  const { fake, id } = await openProject(page, { "a.md": NOTE }, "a.md")
  await saveMyLine(page, fake)
  await changeOnServer(fake, id, "a.md", `${NOTE}Their line\n`)
  await reconnect(page, fake)

  const hex = palettes.find((palette) => palette.id === "cherry-paper")!.light.warnBg
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  const banner = page.getByRole("alert").filter({ hasText: "was changed on another device too" })
  await expect(banner).toHaveCSS("background-color", `rgb(${r}, ${g}, ${b})`)
})

test("Compare says so when the server deleted the note, instead of a diff", async ({ page }) => {
  const { fake, id } = await openProject(page, { "a.md": NOTE }, "a.md")
  await saveMyLine(page, fake)
  await changeOnServer(fake, id, "a.md", null)
  await reconnect(page, fake)

  await page.getByRole("button", { name: "Compare" }).click()
  const dialog = page.getByRole("dialog", { name: "Compare a.md" })
  await expect(dialog).toContainText("The server no longer has a.md: it was deleted there. Your copy is still on this device.")
  await expect(dialog.locator(".wb-compare-diff")).toHaveCount(0)
  await dialog.getByRole("button", { name: "Close" }).click()
  await expect(dialog).toBeHidden()
  // Closing chooses nothing.
  await expect(page.getByRole("alert").filter({ hasText: "was changed on another device too" })).toBeVisible()
})

test("Compare shows a drawing's two versions as pictures with what changed, and Keep theirs from there resolves it", async ({ page }) => {
  const { fake, id } = await openProject(page, { "sketch.excalidraw": SCENE }, "sketch.excalidraw")
  const canvas = page.locator(".excalidraw canvas").first()
  const status = page.locator(".wb-native-view [aria-live]").first()
  await expect(canvas).toBeVisible()
  fake.offline = true
  const box = (await canvas.boundingBox())!
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2]
  await page.mouse.click(x + 200, y + 100)
  await page.keyboard.press("2")
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 140, y + 90, { steps: 8 })
  await page.mouse.up()
  await expect(status).toContainText("Unsaved changes")
  await page.keyboard.press("ControlOrMeta+s")
  await expect(status).toContainText("Saved sketch.excalidraw.")
  const theirs = serverScene()
  await changeOnServer(fake, id, "sketch.excalidraw", theirs)
  await reconnect(page, fake)

  await page.getByRole("button", { name: "Compare" }).click()
  const dialog = page.getByRole("dialog", { name: "Compare sketch.excalidraw" })
  await expect(dialog.getByRole("img", { name: "The drawing on the server" })).toBeVisible()
  await expect(dialog.getByRole("img", { name: "The drawing on this device" })).toBeVisible()
  // Yours adds the new rectangle, lacks the server's ellipse, and has the box where it was.
  await expect(dialog).toContainText("Compared with the server's copy, yours has 1 element added, 1 removed and 1 changed.")
  await expectNoAxeViolations(page)

  await dialog.getByRole("button", { name: "Keep theirs" }).click()
  await expect(dialog).toBeHidden()
  await expect(status).toContainText("Took the other version.")
  await expect(status).toContainText("2 elements")
  await expect(page.getByRole("alert").filter({ hasText: "was changed on another device too" })).toHaveCount(0)
  expect(fake.server.content(id, "sketch.excalidraw")).toBe(theirs)
})

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test("the note comparison fits, in one column, and axe finds nothing in it", async ({ page }) => {
    const { fake, id } = await openProject(page, { "a.md": NOTE }, "a.md", true)
    await saveMyLine(page, fake)
    await changeOnServer(fake, id, "a.md", `${NOTE}Their line\n`)
    await reconnect(page, fake)

    await page.getByRole("button", { name: "Compare" }).click()
    const dialog = page.getByRole("dialog", { name: "Compare a.md" })
    await expect(dialog.getByText("Lines marked − are on the server, and lines marked + are on this device.")).toBeVisible()
    await expect(dialog.locator(".editor.modified")).toContainText("My line")
    await expect(dialog.locator(".editor.modified")).toContainText("Their line")
    await expectNoAxeViolations(page)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
    const box = await dialog.boundingBox()
    expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true)
  })
})
