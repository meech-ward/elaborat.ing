import AxeBuilder from "./axe.ts"
import { expect, test, type Page } from "@playwright/test"
import { fakeSupabase, person, quiet, signedIn, type FakeSupabase } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

/** Wait for the explorer (a desktop opens with it shown). */
async function showExplorer(page: Page) {
  await expect(page.getByRole("navigation", { name: "Workspace files" }).first()).toBeVisible()
}


// A new note, drawing, diagram or folder asks for its name first, in the
// explorer where it will appear (a dialog on a phone), and a new note that was
// never saved can be renamed.

test.describe.configure({ timeout: 60_000 })

const projectUrl = (id: string, path?: string) => new URL(`projects/${id}${path ? `/${path}` : ""}`, APP_URL).href

const DRAWING = `${JSON.stringify({ type: "excalidraw", version: 2, source: "https://excalidraw.com", elements: [], appState: {}, files: {} }, null, 2)}\n`

async function openProject(page: Page, files: Record<string, string>, folders: string[] = [], phone = false) {
  const fake = await fakeSupabase(page)
  const remote = fake.server.remote(person.id)
  const id = crypto.randomUUID()
  await remote.createProject(id, "Notes")
  for (const folder of folders) await remote.saveFiles(id, crypto.randomUUID(), [{ op: "mkdir", path: folder }])
  for (const [path, content] of Object.entries(files)) await remote.saveFiles(id, crypto.randomUUID(), [{ op: "put", path, content }])
  await signedIn(page)
  await page.goto(projectUrl(id))
  if (phone) await expect(page.getByRole("button", { name: "Back to files and projects" })).toBeVisible({ timeout: 15_000 })
  else await expect(page.getByRole("status").filter({ hasText: "Synced" })).toBeVisible({ timeout: 15_000 })
  return { fake, id }
}

/** Choose an item from the workbench menu. */
async function fromMenu(page: Page, item: string) {
  await page.getByRole("button", { name: "Workbench menu" }).click()
  await page.getByRole("menuitem", { name: item, exact: true }).click()
}

const nameField = (page: Page, noun: string) => page.getByRole("textbox", { name: new RegExp(`^Name of the new ${noun} in `) })
const serverPaths = (fake: FakeSupabase, id: string) => fake.server.paths(id)

async function expectNoAxeViolations(page: Page, selector: string) {
  const results = await new AxeBuilder({ page }).include(selector).analyze()
  expect(results.violations.map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => node.target) }))).toEqual([])
}

const kinds = [
  { item: "New", noun: "note", proposed: "untitled.mdx", name: "ideas", path: "ideas.mdx", existing: "# Ideas\n" },
  { item: "New drawing", noun: "drawing", proposed: "untitled.excalidraw", name: "sketch", path: "sketch.excalidraw", existing: DRAWING },
  { item: "New diagram", noun: "diagram", proposed: "untitled.d2", name: "flow", path: "flow.d2", existing: "a -> b\n" },
]

for (const kind of kinds) {
  test(`a new ${kind.noun} asks for its name, and Enter saves it under that name and opens it`, async ({ page }) => {
    const { fake, id } = await openProject(page, { "a.md": "a\n" })
    await fromMenu(page, kind.item)
    const field = nameField(page, kind.noun)
    await expect(field).toBeFocused()
    await expect(field).toHaveValue(kind.proposed)
    // The proposed name is selected up to its extension, so typing replaces just that part.
    await page.keyboard.type(kind.name)
    await expect(field).toHaveValue(kind.path)
    await page.keyboard.press("Enter")
    await expect(field).toHaveCount(0)
    await expect(page.getByRole("tab", { name: kind.path })).toBeVisible()
    await expect.poll(() => serverPaths(fake, id)).toEqual(["a.md", kind.path].sort())
  })

  test(`Escape creates no ${kind.noun}, and a taken name is refused in place`, async ({ page }) => {
    const { fake, id } = await openProject(page, { "a.md": "a\n", [kind.path]: kind.existing })
    // The project opens its first note by itself, sometimes after "Synced" shows.
    // Wait for that, so any change to the tabs below comes from this journey.
    const tabs = () => page.getByRole("tab").allTextContents()
    await expect(page.getByRole("tab", { name: "a.md" })).toBeVisible()
    const opened = await tabs()
    await fromMenu(page, kind.item)
    const field = nameField(page, kind.noun)
    await page.keyboard.type(kind.name)
    await page.keyboard.press("Enter")
    await expect(page.getByRole("alert").filter({ hasText: `${kind.path} already exists here. Choose another name.` })).toBeVisible()
    await expect(field).toBeFocused()
    await expect(field).toHaveAttribute("aria-invalid", "true")
    await expectNoAxeViolations(page, ".wb-explorer")

    await page.keyboard.press("Escape")
    await expect(field).toHaveCount(0)
    await quiet(fake)
    expect(await tabs()).toEqual(opened)
    expect(serverPaths(fake, id)).toEqual(["a.md", kind.path].sort())
  })
}

test("a new folder from the palette is named in the selected folder, and Enter creates it", async ({ page }) => {
  const { fake, id } = await openProject(page, { "notes/a.md": "a\n" })
  await showExplorer(page)
  await page.getByRole("button", { name: "Select folder notes for creation" }).click()
  await page.keyboard.press("ControlOrMeta+k")
  await page.getByLabel("Search commands").first().fill("New folder")
  await page.keyboard.press("Enter")
  const field = nameField(page, "folder")
  await expect(field).toBeFocused()
  await expect(field).toHaveAccessibleName("Name of the new folder in notes")
  await page.keyboard.type("drafts")
  await page.keyboard.press("Enter")
  await expect(field).toHaveCount(0)
  await expect(page.getByText("Created folder notes/drafts.")).toBeVisible()
  await expect.poll(() => [...fake.server.projects.get(id)!.folders]).toEqual(["notes/drafts"])
})

test("a new note that was never saved can be renamed, and is saved under the new name", async ({ page }) => {
  const { fake, id } = await openProject(page, { "a.md": "a\n" })
  // An imported note is not a file until it is saved; an edit keeps it as a draft across a reload.
  await page.getByLabel("Import a file from this computer into the project").setInputFiles({ name: "imported.md", mimeType: "text/markdown", buffer: Buffer.from("# Imported\n") })
  await expect(page.getByRole("tab", { name: "imported.md" })).toBeVisible()
  await page.locator(".monaco-editor:visible .view-lines").first().click()
  await page.keyboard.press("ControlOrMeta+End")
  await page.keyboard.type("Kept.")
  await expect(page.getByRole("tab", { name: "imported.md, unsaved changes" })).toBeVisible()
  await page.waitForTimeout(500)
  await page.reload()
  await expect(page.getByRole("tab", { name: "imported.md" })).toBeVisible({ timeout: 15_000 })

  await showExplorer(page)
  await page.getByRole("button", { name: "Actions for imported.md" }).click()
  await page.getByRole("menuitem", { name: "Rename" }).click()
  const dialog = page.getByRole("dialog", { name: "Rename in the workspace root" })
  await dialog.getByLabel("New file name").fill("renamed.md")
  await dialog.getByRole("button", { name: "Rename" }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole("tab", { name: "renamed.md" })).toBeVisible()
  await expect(page.getByRole("tab", { name: "imported.md" })).toHaveCount(0)
  await expect(page.locator(".monaco-editor:visible .view-lines").first()).toContainText("Kept.")
  await quiet(fake)
  expect(serverPaths(fake, id)).toEqual(["a.md"])

  await page.locator(".monaco-editor:visible .view-lines").first().click()
  await page.keyboard.press("ControlOrMeta+s")
  await expect.poll(() => fake.server.content(id, "renamed.md")).toBe("# Imported\nKept.")
  expect(serverPaths(fake, id)).toEqual(["a.md", "renamed.md"])
})

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test("a dialog asks for the new note's name, and axe finds nothing in it", async ({ page }) => {
    const { fake, id } = await openProject(page, { "a.mdx": "a\n" }, [], true)
    await page.getByRole("button", { name: "Back to files and projects" }).click()
    await fromMenu(page, "New")
    const dialog = page.getByRole("dialog", { name: "New note in Workspace root" })
    await expect(dialog.getByLabel("Name")).toBeFocused()
    await expect(dialog.getByLabel("Name")).toHaveValue("untitled.mdx")
    await expectNoAxeViolations(page, ".wb-rename")
    await page.keyboard.type("a")
    await page.keyboard.press("Enter")
    await expect(dialog.getByRole("alert")).toHaveText("a.mdx already exists here. Choose another name.")
    await dialog.getByLabel("Name").fill("ideas.mdx")
    await dialog.getByRole("button", { name: "Create" }).click()
    await expect(dialog).toBeHidden()
    await expect.poll(() => serverPaths(fake, id)).toEqual(["a.mdx", "ideas.mdx"])
  })
})
