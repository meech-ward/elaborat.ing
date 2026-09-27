import AxeBuilder from "./axe.ts"
import { expect, test, type Page } from "@playwright/test"
import { fakeSupabase, person, quiet, signedIn, type FakeSupabase } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

// Deleting files and folders from the explorer. A confirmation names what
// goes and the files that still refer to it; the delete reaches the server as
// one save, a D2 diagram's generated files go with it, open tabs of deleted
// files close, and unsaved edits stop a delete until they are saved.

const projectUrl = (id: string, path?: string) => new URL(`projects/${id}${path ? `/${path}` : ""}`, APP_URL).href

test.describe.configure({ timeout: 60_000 })

const SCENE = '{\n  "type": "excalidraw",\n  "version": 2,\n  "elements": [],\n  "appState": {},\n  "files": {}\n}\n'

async function openProject(page: Page, files: Record<string, string>, folders: string[], path?: string, phone = false) {
  const fake = await fakeSupabase(page)
  const remote = fake.server.remote(person.id)
  const id = crypto.randomUUID()
  await remote.createProject(id, "Notes")
  for (const folder of folders) await remote.saveFiles(id, crypto.randomUUID(), [{ op: "mkdir", path: folder }])
  for (const [file, content] of Object.entries(files)) await remote.saveFiles(id, crypto.randomUUID(), [{ op: "put", path: file, content }])
  await signedIn(page)
  await page.goto(projectUrl(id, path))
  if (phone) await expect(page.getByRole("button", { name: "Back to files and projects" })).toBeVisible({ timeout: 15_000 })
  else await expect(page.getByRole("status").filter({ hasText: "Synced" })).toBeVisible({ timeout: 15_000 })
  return { fake, id }
}

/** Every save the app sent to the server, as the list of changes in each. */
function saves(fake: FakeSupabase) {
  return fake.requests
    .filter((request) => request.url().endsWith("/rpc/save_files"))
    .map((request) => (request.postDataJSON() as { changes: Array<{ op: string; path: string }> }).changes)
}

/** Show the explorer (hidden at first on a desktop) and return it. */
async function explorer(page: Page) {
  const toggle = page.getByRole("button", { name: "Toggle explorer" })
  if ((await toggle.isVisible()) && (await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click()
  return page.getByRole("navigation", { name: "Workspace files" }).first()
}

/** Pick Delete in the action menu of a file, or of a folder, expanding the folders above it first. */
async function deleteFrom(page: Page, path: string, kind: "file" | "folder" = "file") {
  const files = await explorer(page)
  const parts = path.split("/").slice(0, -1)
  for (let i = 1; i <= parts.length; i++) {
    const expand = files.getByRole("button", { name: `Expand ${parts.slice(0, i).join("/")}`, exact: true })
    if (await expand.count()) await expand.click()
  }
  await files.getByRole("button", { name: `Actions for ${kind === "folder" ? "folder " : ""}${path}`, exact: true }).click()
  await page.getByRole("menuitem", { name: "Delete" }).click()
}

const editorText = (page: Page) => page.locator(".monaco-editor:visible .view-lines").first()

test("deleting a note lists the links to it, closes its tab, and reaches the server as one save", async ({ page }) => {
  const { fake, id } = await openProject(page, { "notes/plan.md": "# Plan\n", "index.md": "See [the plan](notes/plan.md).\n" }, [], "notes/plan.md")
  // index.md opens in a second tab, and the note goes back in front.
  await (await explorer(page)).getByRole("button", { name: "index.md", exact: true }).click()
  await expect(page.getByRole("tab", { name: "index.md" })).toHaveAttribute("aria-selected", "true")
  await page.getByRole("tab", { name: "notes/plan.md" }).click()
  await expect(page.getByRole("tab", { name: "notes/plan.md" })).toHaveAttribute("aria-selected", "true")
  const before = saves(fake).length

  await deleteFrom(page, "notes/plan.md")
  const dialog = page.getByRole("alertdialog", { name: "Delete notes/plan.md" })
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused()
  const what = dialog.getByRole("region", { name: "What goes" })
  await expect(what.getByText("notes/plan.md", { exact: true })).toBeVisible()
  await expect(what.getByText("Line 1: notes/plan.md", { exact: true })).toBeVisible()
  await expect(what.getByText("Their references stay as they are.")).toBeVisible()
  const results = await new AxeBuilder({ page }).include(".wb-move").analyze()
  expect(results.violations.map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => node.target) }))).toEqual([])

  await dialog.getByRole("button", { name: "Delete", exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByText("Deleted notes/plan.md.")).toBeVisible()
  // Its tab closes, and the other one comes to the front.
  await expect(page.getByRole("tab", { name: "notes/plan.md" })).toHaveCount(0)
  await expect(page.getByRole("tab", { name: "index.md" })).toHaveAttribute("aria-selected", "true")
  await expect(page).toHaveURL(projectUrl(id, "index.md"))
  await expect((await explorer(page)).getByRole("button", { name: "notes/plan.md", exact: true })).toHaveCount(0)

  await expect.poll(() => fake.server.paths(id)).toEqual(["index.md"])
  // The link is left as it was.
  expect(fake.server.content(id, "index.md")).toBe("See [the plan](notes/plan.md).\n")
  await quiet(fake, 1_500)
  expect(saves(fake).slice(before)).toEqual([[expect.objectContaining({ op: "delete", path: "notes/plan.md" })]])
})

test("deleting a folder takes a diagram's three files and the folder itself, in one save", async ({ page }) => {
  const { fake, id } = await openProject(
    page,
    {
      "diagrams/flow.d2": "a -> b\n",
      "diagrams/flow.excalidraw": SCENE,
      "diagrams/flow.d2.json": '{"layout":"elk"}\n',
      "page.mdx": '# Page\n\n<Diagram src="diagrams/flow.d2" />\n',
    },
    ["diagrams"],
    "page.mdx",
  )
  const before = saves(fake).length

  await deleteFrom(page, "diagrams", "folder")
  const dialog = page.getByRole("alertdialog", { name: "Delete folder diagrams" })
  const what = dialog.getByRole("region", { name: "What goes" })
  for (const path of ["diagrams/flow.d2", "diagrams/flow.excalidraw", "diagrams/flow.d2.json", "diagrams"]) {
    await expect(what.getByText(path, { exact: true })).toBeVisible()
  }
  await expect(what.getByText("Line 3: diagrams/flow.d2", { exact: true })).toBeVisible()
  await dialog.getByRole("button", { name: "Delete", exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByText("Deleted diagrams with the 3 files in it.")).toBeVisible()
  await expect((await explorer(page)).getByRole("button", { name: "Select folder diagrams for creation" })).toHaveCount(0)

  await expect.poll(() => fake.server.paths(id)).toEqual(["page.mdx"])
  expect(await fake.server.remote(person.id).folders(id)).toEqual([])
  expect(fake.server.content(id, "page.mdx")).toBe('# Page\n\n<Diagram src="diagrams/flow.d2" />\n')
  await quiet(fake, 1_500)
  const sent = saves(fake).slice(before)
  expect(sent).toHaveLength(1)
  expect(sent[0]).toHaveLength(4)
  expect(sent[0]).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ op: "delete", path: "diagrams/flow.d2" }),
      expect.objectContaining({ op: "delete", path: "diagrams/flow.excalidraw" }),
      expect.objectContaining({ op: "delete", path: "diagrams/flow.d2.json" }),
      { op: "rmdir", path: "diagrams" },
    ]),
  )
})

test("cancelling the confirmation sends nothing and keeps the file", async ({ page }) => {
  const { fake, id } = await openProject(page, { "plan.md": "# Plan\n", "index.md": "# Index\n" }, [], "index.md")
  const before = saves(fake).length
  await deleteFrom(page, "plan.md")
  const dialog = page.getByRole("alertdialog", { name: "Delete plan.md" })
  await expect(dialog.getByRole("region", { name: "What goes" }).getByText("plan.md", { exact: true })).toBeVisible()
  await dialog.getByRole("button", { name: "Cancel" }).click()
  await expect(dialog).toBeHidden()
  // Focus returns to the file's row, which is still there.
  await expect((await explorer(page)).getByRole("button", { name: "plan.md", exact: true })).toBeFocused()
  await quiet(fake, 1_500)
  expect(saves(fake).slice(before)).toEqual([])
  expect(fake.server.content(id, "plan.md")).toBe("# Plan\n")
})

test("a note with unsaved edits cannot be deleted until they are saved", async ({ page }) => {
  const { fake, id } = await openProject(page, { "notes/plan.md": "# Plan\n" }, [], "notes/plan.md")
  await editorText(page).click()
  await page.keyboard.press("ControlOrMeta+End")
  await page.keyboard.type("More.")
  await expect(page.getByText("Unsaved changes", { exact: true })).toBeVisible()
  const before = saves(fake).length

  await deleteFrom(page, "notes/plan.md")
  const dialog = page.getByRole("alertdialog", { name: "Delete notes/plan.md" })
  await expect(dialog.getByRole("alert")).toHaveText("notes/plan.md: It has unsaved edits. Save or discard them before deleting it.")
  await expect(dialog.getByRole("button", { name: "Delete", exact: true })).toBeDisabled()
  await dialog.getByRole("button", { name: "Cancel" }).click()
  await expect(dialog).toBeHidden()
  await quiet(fake, 1_500)
  expect(saves(fake).slice(before)).toEqual([])
  expect(fake.server.content(id, "notes/plan.md")).toBe("# Plan\n")
  await expect(page.getByRole("tab", { name: "notes/plan.md" })).toBeVisible()

  // Once saved, it can go.
  await editorText(page).click()
  await page.keyboard.press("ControlOrMeta+s")
  await expect(page.getByText("Unsaved changes", { exact: true })).toHaveCount(0)
  await deleteFrom(page, "notes/plan.md")
  await dialog.getByRole("button", { name: "Delete", exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole("tab", { name: "notes/plan.md" })).toHaveCount(0)
  await expect.poll(() => fake.server.paths(id)).toEqual([])
})

test("deleting the only open file keeps the project page: the explorer stays open and the notice shows", async ({ page }) => {
  const { id } = await openProject(page, { "plan.md": "# Plan\n", "other.md": "# Other\n" }, [], "plan.md")
  const files = await explorer(page)
  await expect(page.getByRole("tab")).toHaveCount(1)

  // With its last tab closed, the page moves to the project's own URL and stays the same page.
  await deleteFrom(page, "plan.md")
  await page.getByRole("alertdialog", { name: "Delete plan.md" }).getByRole("button", { name: "Delete", exact: true }).click()
  await expect(page).toHaveURL(projectUrl(id))
  await expect(page.getByText("Deleted plan.md.")).toBeVisible()
  await expect(page.getByRole("tab")).toHaveCount(0)
  await expect(files).toBeVisible()

  // Opening a file from there keeps it too.
  await files.getByRole("button", { name: "other.md", exact: true }).click()
  await expect(page).toHaveURL(projectUrl(id, "other.md"))
  await expect(page.getByRole("tab", { name: "other.md" })).toBeVisible()
  await expect(files).toBeVisible()
})

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test("the delete confirmation fits, and axe finds nothing in it", async ({ page }) => {
    await openProject(page, { "notes/a.md": "# A\n", "index.md": "[a](notes/a.md)\n" }, [], undefined, true)
    await page.getByRole("button", { name: "Back to files and projects" }).click()
    await deleteFrom(page, "notes/a.md")
    const dialog = page.getByRole("alertdialog", { name: "Delete notes/a.md" })
    await expect(dialog.getByRole("region", { name: "What goes" }).getByText("Line 1: notes/a.md", { exact: true })).toBeVisible()
    const results = await new AxeBuilder({ page }).include(".wb-move").analyze()
    expect(results.violations.map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => node.target) }))).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
    const box = await dialog.boundingBox()
    expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true)
  })
})
