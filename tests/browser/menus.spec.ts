import AxeBuilder from "./axe.ts"
import { expect, test, type Locator, type Page } from "@playwright/test"
import { fakeSupabase, person, signedIn } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

// Every menu shares one look. A file's menu works from the keyboard, its
// highlighted item takes the highlight colours, and the action button and a
// right-click on the row list the same items. The tree marks each file's
// kind and follows the active tab.

const projectUrl = (id: string, path?: string) => new URL(`projects/${id}${path ? `/${path}` : ""}`, APP_URL).href

test.describe.configure({ timeout: 60_000 })

const SCENE = '{\n  "type": "excalidraw",\n  "version": 2,\n  "elements": [],\n  "appState": {},\n  "files": {}\n}\n'

async function openProject(page: Page, files: Record<string, string>, path?: string, phone = false) {
  const fake = await fakeSupabase(page)
  const remote = fake.server.remote(person.id)
  const id = crypto.randomUUID()
  await remote.createProject(id, "Notes")
  for (const [file, content] of Object.entries(files)) await remote.saveFiles(id, crypto.randomUUID(), [{ op: "put", path: file, content }])
  await signedIn(page)
  await page.goto(projectUrl(id, path))
  if (phone) await expect(page.getByRole("button", { name: "Back to files and projects" })).toBeVisible({ timeout: 15_000 })
  else await expect(page.getByRole("status").filter({ hasText: "Synced" })).toBeVisible({ timeout: 15_000 })
  return { fake, id }
}

/** The explorer (shown on a desktop). */
async function explorer(page: Page) {
  return page.getByRole("navigation", { name: "Workspace files" }).first()
}

/** The open menu's item names, then the menu closed again. */
async function itemsOfOpenMenu(page: Page) {
  const menu = page.getByRole("menu")
  await expect(menu).toBeVisible()
  const items = await menu.getByRole("menuitem").allTextContents()
  await page.keyboard.press("Escape")
  await expect(menu).toBeHidden()
  return items
}

/** Duplicate's text in a menu: the name, then its shortcut. */
const duplicateItem = async (page: Page) =>
  `Duplicate${await page.evaluate(() => (/Mac|iPhone|iPad|iPod/.test(navigator.platform) ? "⌘D" : "Ctrl+D"))}`

/** A colour as the browser computes it, from a CSS value such as var(--accent-soft-text). */
async function computed(page: Page, value: string) {
  return page.evaluate((value) => {
    const probe = document.createElement("span")
    probe.style.color = value
    document.body.append(probe)
    const color = getComputedStyle(probe).color
    probe.remove()
    return color
  }, value)
}

const colours = (item: Locator) => item.evaluate((element) => {
  const style = getComputedStyle(element)
  return { background: style.backgroundColor, text: style.color }
})

test("a file's menu works from the keyboard, highlights in the highlight colours, and gives focus back", async ({ page }) => {
  await openProject(page, { "a.md": "# A\n", "b.md": "# B\n" }, "a.md")
  const files = await explorer(page)
  const trigger = files.getByRole("button", { name: "Actions for b.md", exact: true })
  await trigger.focus()
  await page.keyboard.press("Enter")
  const menu = page.getByRole("menu", { name: "Actions for b.md" })
  await expect(menu).toBeVisible()
  expect(await menu.getByRole("menuitem").allTextContents()).toEqual(["Copy filename", "Copy path", "Rename", await duplicateItem(page), "Move to folder", "Delete"])

  const remove = menu.getByRole("menuitem", { name: "Delete" })
  for (let step = 0; step < 6 && (await remove.getAttribute("data-highlighted")) === null; step++) await page.keyboard.press("ArrowDown")
  await expect(remove).toHaveAttribute("data-highlighted")
  await expect(remove).toBeFocused()
  expect(await colours(remove)).toEqual({ background: await computed(page, "var(--accent-soft)"), text: await computed(page, "var(--accent-soft-text)") })
  // Delete is destructive: last, in the danger colour when it is not highlighted.
  await page.keyboard.press("ArrowUp")
  expect((await colours(remove)).text).toBe(await computed(page, "var(--danger)"))

  await page.keyboard.press("Escape")
  await expect(menu).toBeHidden()
  await expect(trigger).toBeFocused()
})

test("the action button and a right-click on the row list the same items", async ({ page }) => {
  await openProject(page, { "a.md": "# A\n", "notes/b.md": "# B\n" }, "a.md")
  const files = await explorer(page)

  await files.getByRole("button", { name: "Actions for a.md", exact: true }).click()
  const fromButton = await itemsOfOpenMenu(page)
  await files.getByRole("button", { name: "a.md", exact: true }).click({ button: "right" })
  expect(await itemsOfOpenMenu(page)).toEqual(fromButton)
  expect(fromButton).toEqual(["Copy filename", "Copy path", "Rename", await duplicateItem(page), "Move to folder", "Delete"])

  await files.getByRole("button", { name: "Actions for folder notes", exact: true }).click()
  const folderFromButton = await itemsOfOpenMenu(page)
  await files.getByRole("button", { name: "notes", exact: true }).click({ button: "right" })
  expect(await itemsOfOpenMenu(page)).toEqual(folderFromButton)
  expect(folderFromButton).toEqual(["Rename", "Move to folder", "Delete"])
})

test("the tree marks each file's kind and follows the active tab", async ({ page }) => {
  await openProject(page, {
    "README.md": "# Read me\n",
    "notes/plan.md": "# Plan\n",
    "flow.excalidraw": SCENE,
    "signup.d2": "a -> b\n",
    "data.json": "{}\n",
  }, "notes/plan.md")
  const files = await explorer(page)
  const badge = (name: string) => files.getByRole("button", { name, exact: true }).locator("[data-kind]")
  await expect(badge("README.md")).toHaveText("M")
  await expect(badge("notes/plan.md")).toHaveText("M")
  await expect(badge("flow.excalidraw")).toHaveText("D")
  await expect(badge("signup.d2")).toHaveText("2")
  await expect(badge("data.json")).toHaveText("")

  // Another file becomes the active tab; its row is marked, the note's is not.
  await files.getByRole("button", { name: "README.md", exact: true }).click()
  await expect(page.getByRole("tab", { name: "README.md" })).toHaveAttribute("aria-selected", "true")
  await expect(files.getByRole("button", { name: "README.md", exact: true })).toHaveAttribute("aria-current", "true")
  await expect(files.getByRole("button", { name: "notes/plan.md", exact: true })).not.toHaveAttribute("aria-current", "true")

  // Its folder closed, the note's tab brings the folder back open with the row marked and in view.
  await files.getByRole("button", { name: "notes", exact: true, expanded: true }).click()
  await expect(files.getByRole("button", { name: "notes/plan.md", exact: true })).toHaveCount(0)
  await page.getByRole("tab", { name: "notes/plan.md" }).click()
  const plan = files.getByRole("button", { name: "notes/plan.md", exact: true })
  await expect(plan).toHaveAttribute("aria-current", "true")
  await expect(plan).toBeInViewport()
  await expect(files.getByRole("button", { name: "notes", exact: true, expanded: true })).toBeVisible()
})

for (const [width, scheme] of [
  [1280, "light"],
  [390, "dark"],
] as const) {
  test.describe(`at ${width}px in ${scheme} mode`, () => {
    const phone = width < 600
    test.use({ viewport: { width, height: phone ? 844 : 900 }, hasTouch: phone, colorScheme: scheme })

    test("axe finds nothing in an open file menu", async ({ page }) => {
      await openProject(page, { "a.md": "# A\n", "b.md": "# B\n" }, "a.md", phone)
      if (phone) await page.getByRole("button", { name: "Back to files and projects" }).click()
      const files = await explorer(page)
      await files.getByRole("button", { name: "Actions for b.md", exact: true }).click()
      const menu = page.getByRole("menu", { name: "Actions for b.md" })
      await expect(menu).toBeVisible()
      await menu.getByRole("menuitem", { name: "Rename" }).hover()
      const results = await new AxeBuilder({ page }).include('[role="menu"]').analyze()
      expect(results.violations.map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => node.target) }))).toEqual([])
      const box = await menu.boundingBox()
      expect(box && box.x >= 0 && box.x + box.width <= width).toBe(true)
    })
  })
}
