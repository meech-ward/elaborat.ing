import { expect, test, type Page } from "@playwright/test"
import { FakeProjectServer } from "../../src/features/project-storage/fakeServer.ts"
import { fakeSupabase, person, quiet, signedIn } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

// A project the person may only view, or an archived one, opens read-only:
// the page says why, every editor shows its file without changing it, nothing
// is kept as a draft, and nothing offers to create, rename, move or delete
// files. Unarchiving lifts it without a reload.

test.describe.configure({ timeout: 60_000 })

const projectUrl = (id: string, path?: string) => new URL(`projects/${id}${path ? `/${path}` : ""}`, APP_URL).href
const SOMEONE_ELSE = "5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f"
const SCENE = '{\n  "type": "excalidraw",\n  "version": 2,\n  "elements": [],\n  "appState": {},\n  "files": {}\n}\n'
const NOTE = "# Plan\n\nThe first paragraph."

const editorText = (page: Page) => page.locator(".monaco-editor:visible .view-lines").first()
const saves = (fake: { requests: { url(): string }[] }) => fake.requests.filter((request) => request.url().endsWith("/rpc/save_files"))

/** Show the explorer (hidden at first on a desktop) and return it. */
async function explorer(page: Page) {
  const toggle = page.getByRole("button", { name: "Toggle explorer" })
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click()
  return page.getByRole("navigation", { name: "Workspace files" }).first()
}

/** The items of a menu opened by `trigger`, then the menu closed again. */
async function menuItems(page: Page, trigger: ReturnType<Page["getByRole"]>) {
  await trigger.click()
  const menu = page.getByRole("menu")
  await expect(menu).toBeVisible()
  const items = await menu.getByRole("menuitem").allTextContents()
  await page.keyboard.press("Escape")
  await expect(menu).toBeHidden()
  return items.map((item) => item.trim())
}

/** Type at the end of the visible source editor. */
async function typeInSource(page: Page, text: string) {
  await editorText(page).click()
  await page.keyboard.press("ControlOrMeta+End")
  await page.keyboard.type(text)
}

test("a viewer reads a note without changing it, keeps no draft, and is offered no file changes", async ({ page }) => {
  const server = new FakeProjectServer()
  const owner = server.remote(SOMEONE_ELSE)
  const id = crypto.randomUUID()
  await owner.createProject(id, "Their notes")
  await owner.saveFiles(id, crypto.randomUUID(), [
    { op: "put", path: "notes/plan.md", content: NOTE },
    { op: "put", path: "sketch.excalidraw", content: SCENE },
  ])
  server.share(id, person.id, "viewer")
  const fake = await fakeSupabase(page, { server })
  await signedIn(page)
  await page.goto(projectUrl(id, "notes/plan.md"))
  // The page header says why (the editor repeats it when someone types).
  await expect(page.getByRole("banner").getByText("You can view this project but not change it.")).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole("tab", { name: "notes/plan.md" })).toBeVisible()

  // Typing in Source changes nothing.
  await expect(editorText(page)).toContainText("The first paragraph.")
  await typeInSource(page, " TYPED")
  await expect(editorText(page)).not.toContainText("TYPED")
  await expect(page.getByText("Unsaved changes", { exact: true })).toHaveCount(0)

  // Nor does typing in Rendered, which offers no block to insert.
  await page.getByRole("button", { name: "Rendered" }).click()
  const frame = page.frameLocator('iframe[title="Isolated document preview"]')
  const paragraph = frame.locator("p").filter({ hasText: "The first paragraph." })
  await expect(paragraph).toBeVisible({ timeout: 15_000 })
  await expect(frame.getByRole("textbox", { name: "Rendered document" })).toHaveAttribute("contenteditable", "false")
  await paragraph.click()
  await page.keyboard.type(" TYPED")
  await expect(paragraph).toHaveText("The first paragraph.")
  await expect(frame.getByRole("button", { name: "+ Insert block" })).toHaveCount(0)

  // The file can be exported, not saved or formatted.
  expect(await menuItems(page, page.getByRole("button", { name: "File actions" }))).toEqual(["Export"])
  // Nothing creates or imports files.
  const workbench = await menuItems(page, page.getByRole("button", { name: "Workbench menu" }))
  for (const item of ["New", "New MDX note", "New drawing", "New diagram", "Import", "New folder"]) expect(workbench).not.toContain(item)

  // The explorer offers no Rename, Move or Delete, for files or folders.
  const files = await explorer(page)
  expect(await menuItems(page, files.getByRole("button", { name: "Actions for notes/plan.md", exact: true }))).toEqual(["Copy filename", "Copy path"])
  await expect(files.getByRole("button", { name: "Actions for folder notes", exact: true })).toHaveCount(0)
  await expect(files.getByRole("button", { name: "New folder" })).toHaveCount(0)

  // A drawing opens in Excalidraw's view mode.
  await files.getByRole("button", { name: "sketch.excalidraw", exact: true }).click()
  await expect(page.locator(".excalidraw.excalidraw--view-mode")).toBeVisible({ timeout: 15_000 })

  // No draft was kept: after a reload the note is as it was saved, and nothing was sent.
  await page.goto(projectUrl(id, "notes/plan.md"))
  await page.getByRole("button", { name: "Source" }).click()
  await expect(editorText(page)).toContainText("The first paragraph.", { timeout: 15_000 })
  await expect(editorText(page)).not.toContainText("TYPED")
  await expect(page.getByText("Unsaved changes", { exact: true })).toHaveCount(0)
  await quiet(fake, 1_000)
  expect(saves(fake)).toHaveLength(0)
  expect(server.content(id, "notes/plan.md")).toBe(NOTE)
})

test("an archived project says so, stays read-only, and after Unarchive can be edited and saved", async ({ page }) => {
  const server = new FakeProjectServer()
  const remote = server.remote(person.id)
  const id = crypto.randomUUID()
  await remote.createProject(id, "Notes")
  await remote.saveFiles(id, crypto.randomUUID(), [{ op: "put", path: "plan.md", content: NOTE }])
  await remote.archiveProject(id)
  const fake = await fakeSupabase(page, { server })
  await signedIn(page)
  await page.goto(projectUrl(id, "plan.md"))
  const notice = page.getByRole("banner").getByText("This project is archived. Unarchive it to make changes.")
  await expect(notice).toBeVisible({ timeout: 15_000 })

  await typeInSource(page, " TYPED")
  await expect(editorText(page)).not.toContainText("TYPED")
  await expect(page.getByText("Unsaved changes", { exact: true })).toHaveCount(0)

  // Unarchived, it takes edits at once, without a reload.
  await page.getByRole("button", { name: "Unarchive" }).click()
  await expect(notice).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Unarchive" })).toHaveCount(0)
  expect(server.projects.get(id)!.archivedAt).toBeNull()
  await typeInSource(page, " edited")
  await expect(page.getByText("Unsaved changes", { exact: true })).toBeVisible()
  await page.keyboard.press("ControlOrMeta+s")
  await expect.poll(() => server.content(id, "plan.md")).toBe(`${NOTE} edited`)
  expect(saves(fake).length).toBeGreaterThan(0)
})
