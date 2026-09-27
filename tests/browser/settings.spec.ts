import AxeBuilder from "@axe-core/playwright"
import { expect, test, type Page } from "@playwright/test"
import { palettes } from "../../src/features/appearance/palettes.ts"
import { fakeSupabase, person, signedIn } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

// Settings > Appearance: the colour palette and light, dark or the device's
// setting, kept on this device.

test.describe.configure({ timeout: 60_000 })

const glacier = palettes.find((palette) => palette.id === "glacier-cyan")!
const supabase = palettes.find((palette) => palette.id === "supabase-green")!
// The document area takes the palette's panel colour (--panel, palettes.css),
// compared as the browser computes it: the built CSS may shorten #FFFFFF to #fff.
const background = (page: Page) => page.evaluate(() => {
  const probe = document.createElement("span")
  probe.style.color = "var(--panel)"
  document.body.append(probe)
  const color = getComputedStyle(probe).color
  probe.remove()
  return color
})
const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`

async function openProject(page: Page) {
  const fake = await fakeSupabase(page)
  const id = crypto.randomUUID()
  await fake.server.remote(person.id).createProject(id, "Notes")
  await signedIn(page)
  await page.goto(new URL(`projects/${id}`, APP_URL).href)
  await expect(page.getByRole("status").filter({ hasText: "Synced" })).toBeVisible({ timeout: 15_000 })
}

test("a palette and dark mode chosen in Settings apply at once and survive a reload", async ({ page }) => {
  await openProject(page)
  await page.getByRole("button", { name: "Workbench menu" }).click()
  await page.getByRole("menuitem", { name: "Settings" }).click()
  const dialog = page.getByRole("dialog", { name: "Settings" })
  await dialog.getByRole("radio", { name: "Glacier Cyan" }).check()
  await dialog.getByRole("radio", { name: "Dark" }).check()
  await expect.poll(() => background(page)).toBe(rgb(glacier.dark.panel))
  // Check contrast once the dialog has finished fading in.
  // A colour change can replace a running transition, which cancels it, so wait for none to be running.
  await expect.poll(() => dialog.evaluate((element) => element.getAnimations({ subtree: true }).every((animation) => animation.playState !== "running"))).toBe(true)
  expect(await new AxeBuilder({ page }).include('[role="dialog"]').analyze().then((result) => result.violations)).toEqual([])

  await page.reload()
  await expect.poll(() => background(page)).toBe(rgb(glacier.dark.panel))
})

test("System follows the device while the page is open", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" })
  await openProject(page)
  await page.getByRole("button", { name: "Workbench menu" }).click()
  await page.getByRole("menuitem", { name: "Settings" }).click()
  await page.getByRole("dialog", { name: "Settings" }).getByRole("radio", { name: "System" }).check()
  await expect.poll(() => background(page)).toBe(rgb(supabase.light.panel))
  await page.emulateMedia({ colorScheme: "dark" })
  await expect.poll(() => background(page)).toBe(rgb(supabase.dark.panel))
})

test("a first visit is Supabase Green, following the device", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" })
  await openProject(page)
  await expect.poll(() => background(page)).toBe(rgb(supabase.light.panel))
  await expect(page.locator("html")).not.toHaveClass(/dark/)
})

test("Settings opens from the home page", async ({ page }) => {
  await fakeSupabase(page)
  await page.goto(APP_URL)
  await page.getByRole("button", { name: "Settings" }).click()
  await expect(page.getByRole("dialog", { name: "Settings" }).getByRole("radio", { name: "Supabase Green" })).toBeChecked()
})

test("the code editor and the drawing canvas take the chosen palette's colours, and the drawing stays unchanged", async ({ page }) => {
  const cherry = palettes.find((palette) => palette.id === "cherry-paper")!.light
  const scene = `${JSON.stringify({ type: "excalidraw", version: 2, elements: [], appState: { viewBackgroundColor: "#ffffff" }, files: {} })}\n`
  await page.emulateMedia({ colorScheme: "dark" })
  const fake = await fakeSupabase(page)
  const id = crypto.randomUUID()
  const remote = fake.server.remote(person.id)
  await remote.createProject(id, "Notes")
  await remote.saveFiles(id, crypto.randomUUID(), [
    { op: "put", path: "note.md", content: "# Note\n\nSome *text*.\n" },
    { op: "put", path: "sketch.excalidraw", content: scene },
  ])
  await signedIn(page)
  await page.goto(new URL(`projects/${id}/sketch.excalidraw`, APP_URL).href)
  await expect(page.getByRole("status").filter({ hasText: "Synced" })).toBeVisible({ timeout: 15_000 })
  await page.locator(".excalidraw canvas.static:visible").waitFor()

  await page.getByRole("button", { name: "Workbench menu" }).click()
  await page.getByRole("menuitem", { name: "Settings" }).click()
  const dialog = page.getByRole("dialog", { name: "Settings" })
  await dialog.getByRole("radio", { name: "Cherry Paper" }).check()
  await dialog.getByRole("radio", { name: "Light", exact: true }).check()
  await page.keyboard.press("Escape")

  // The canvas shows the palette's background (on a desktop it is clear over
  // the window's dotted background, which paints it); the file keeps its own.
  const canvasBackground = () =>
    page.evaluate(() => {
      const hex = (rgb: number[]) => `#${rgb.map((value) => value.toString(16).padStart(2, "0")).join("")}`.toUpperCase()
      const canvas = [...document.querySelectorAll<HTMLCanvasElement>(".excalidraw canvas.static")].find((element) => element.width > 0)!
      const [r, g, b, a] = canvas.getContext("2d")!.getImageData(2, 2, 1, 1).data
      if (a > 0) return hex([r, g, b])
      return hex(getComputedStyle(canvas.closest(".wb-native-stage")!).backgroundColor.match(/\d+/g)!.slice(0, 3).map(Number))
    })
  await expect.poll(canvasBackground).toBe(cherry.bg.toUpperCase())
  await expect(page.getByRole("tab", { name: "sketch.excalidraw" }).getByLabel("unsaved changes")).toHaveCount(0)
  expect(fake.server.content(id, "sketch.excalidraw")).toBe(scene)

  await page.goto(new URL(`projects/${id}/note.md`, APP_URL).href)
  await page.getByRole("button", { name: "Source" }).click()
  const editorBackground = () =>
    page.evaluate(() => {
      const [r, g, b] = getComputedStyle(document.querySelector(".monaco-editor .monaco-editor-background")!).backgroundColor.match(/\d+/g)!.map(Number)
      return `#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`.toUpperCase()
    })
  await expect.poll(editorBackground).toBe(cherry.panel.toUpperCase())
})
