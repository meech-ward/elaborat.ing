import AxeBuilder from "./axe.ts"
import { expect, test, type Locator, type Page } from "@playwright/test"
import { fakeSupabase, person, signedIn, type FakeSupabase } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

/** Wait for the explorer (a desktop opens with it shown). */
async function showExplorer(page: Page) {
  await expect(page.getByRole("navigation", { name: "Workspace files" }).first()).toBeVisible()
}


// Folders and files in the explorer: new folders, and renames and moves of
// files and folders whose references are rewritten in the same save. A D2
// diagram's generated files go with it, open tabs follow their files, and
// unsaved edits stop a move until they are saved.

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

const editorText = (page: Page) => page.locator(".monaco-editor:visible .view-lines").first()

/** Every save the app sent to the server, as the list of changes in each. */
function saves(fake: FakeSupabase) {
  return fake.requests
    .filter((request) => request.url().endsWith("/rpc/save_files"))
    .map((request) => (request.postDataJSON() as { changes: Array<{ op: string; path: string; to?: string }> }).changes)
}

/** Open a file's action menu in the explorer (shown first on a desktop) and pick an action. */
async function fileAction(page: Page, path: string, action: "Rename" | "Move to folder") {
  const files = page.getByRole("navigation", { name: "Workspace files" }).first()
  const parts = path.split("/").slice(0, -1)
  for (let i = 1; i <= parts.length; i++) {
    const expand = files.getByRole("button", { name: parts.slice(0, i).join("/"), exact: true, expanded: false })
    if (await expand.count()) await expand.click()
  }
  await files.getByRole("button", { name: `Actions for ${path}`, exact: true }).click()
  await page.getByRole("menuitem", { name: action }).click()
}

/** Choose the move's destination folder in its list (the shadcn select). */
async function chooseFolder(dialog: Locator, folder: string) {
  await dialog.getByLabel("Destination folder").click()
  await dialog.page().getByRole("option", { name: folder, exact: true }).click()
}

/** The explorer (shown on a desktop). */
async function explorer(page: Page) {
  return page.getByRole("navigation", { name: "Workspace files" }).first()
}

/** Open a folder's action menu in the explorer and pick an action. */
async function folderAction(page: Page, path: string, action: "Rename" | "Move to folder") {
  await (await explorer(page)).getByRole("button", { name: `Actions for folder ${path}`, exact: true }).click()
  await page.getByRole("menuitem", { name: action }).click()
}

test("renaming a folder moves everything in it and rewrites references to it, in one save", async ({ page }) => {
  const plan = '# Plan\n\n<Drawing src="docs/sketch.excalidraw" />\n'
  const { fake, id } = await openProject(
    page,
    { "docs/plan.mdx": plan, "docs/sketch.excalidraw": SCENE, "index.mdx": "See [the plan](docs/plan.mdx).\n" },
    ["docs"],
    "docs/plan.mdx",
  )
  // The note in the folder stays open in a tab; the one outside it is in front, with the folder expanded.
  const files = await explorer(page)
  await files.getByRole("button", { name: "index.mdx", exact: true }).click()
  await expect(page.getByRole("tab", { name: "index.mdx" })).toHaveAttribute("aria-selected", "true")
  await expect(files.getByRole("button", { name: "docs", exact: true, expanded: true })).toBeVisible()
  const before = saves(fake).length

  await folderAction(page, "docs", "Rename")
  const dialog = page.getByRole("dialog", { name: "Rename folder docs" })
  await dialog.getByLabel("New folder name").fill("notes")
  await dialog.getByLabel("New folder name").press("Enter")
  await expect(page.getByText("Renamed docs to notes with the 2 files in it. Updated references in 1 file.")).toBeVisible()

  // The open notes follow: the link in the front one is rewritten, and the other's tab moved with its file.
  await expect(editorText(page)).toContainText("notes/plan.mdx")
  await expect(page.getByRole("tab", { name: "notes/plan.mdx" })).toBeVisible()
  await expect(page.getByRole("tab", { name: "docs/plan.mdx" })).toHaveCount(0)
  // The folder is still expanded, under its new name.
  await expect(files.getByRole("button", { name: "notes", exact: true, expanded: true })).toBeVisible()

  await expect.poll(() => fake.server.paths(id)).toEqual(["index.mdx", "notes/plan.mdx", "notes/sketch.excalidraw"])
  const moved = '# Plan\n\n<Drawing src="notes/sketch.excalidraw" />\n'
  expect(fake.server.content(id, "notes/plan.mdx")).toBe(moved)
  expect(fake.server.content(id, "notes/sketch.excalidraw")).toBe(SCENE)
  expect(fake.server.content(id, "index.mdx")).toBe("See [the plan](notes/plan.mdx).\n")
  expect(await fake.server.remote(person.id).folders(id)).toEqual(["notes"])
  // One save carried the whole move: both files, the rewritten link, and the folder itself.
  const sent = saves(fake).slice(before)
  expect(sent).toHaveLength(1)
  expect(sent[0]).toHaveLength(5)
  expect(sent[0]).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ op: "move", path: "docs/plan.mdx", to: "notes/plan.mdx", content: moved }),
      expect.objectContaining({ op: "move", path: "docs/sketch.excalidraw", to: "notes/sketch.excalidraw" }),
      expect.objectContaining({ op: "put", path: "index.mdx", content: "See [the plan](notes/plan.mdx).\n" }),
      { op: "mkdir", path: "notes" },
      { op: "rmdir", path: "docs" },
    ]),
  )
})

test("moving a folder into another one previews the folder and its files, and cannot pick itself", async ({ page }) => {
  const { fake, id } = await openProject(
    page,
    { "docs/a.md": "# A\n", "docs/deep/b.md": "# B\n", "index.md": "[A](docs/a.md)\n" },
    ["archive"],
    "index.md",
  )
  await folderAction(page, "docs", "Move to folder")
  const dialog = page.getByRole("dialog", { name: "Move folder" })
  await dialog.getByLabel("Destination folder").click()
  await expect(page.getByRole("option")).toHaveText(["Top level", "archive"])
  await page.getByRole("option", { name: "archive", exact: true }).click()
  await dialog.getByRole("button", { name: "Preview move" }).click()
  const preview = dialog.getByRole("region", { name: "Affected files" })
  await expect(preview.getByText("docs → archive/docs", { exact: true })).toBeVisible()
  await expect(preview.getByText("docs/deep/b.md → archive/docs/deep/b.md", { exact: true })).toBeVisible()
  await expect(preview.getByText("Line 1: docs/a.md → archive/docs/a.md", { exact: true })).toBeVisible()
  await dialog.getByRole("button", { name: "Move", exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByText("Moved docs to archive/docs with the 2 files in it. Updated references in 1 file.")).toBeVisible()
  await expect.poll(() => fake.server.paths(id)).toEqual(["archive/docs/a.md", "archive/docs/deep/b.md", "index.md"])
  expect(fake.server.content(id, "index.md")).toBe("[A](archive/docs/a.md)\n")
})

test("renaming a note rewrites the links to it, in one save that reaches the server", async ({ page }) => {
  const { fake, id } = await openProject(
    page,
    { "notes/plan.md": "# Plan\n", "index.mdx": "See [the plan](notes/plan.md).\n", "other.md": "Unrelated.\n" },
    [],
    "index.mdx",
  )
  await expect(editorText(page)).toContainText("notes/plan.md")
  const before = saves(fake).length

  await fileAction(page, "notes/plan.md", "Rename")
  const dialog = page.getByRole("dialog", { name: "Rename in notes" })
  await dialog.getByLabel("New file name").fill("roadmap.md")
  await dialog.getByLabel("New file name").press("Enter")
  await expect(page.getByText("Renamed notes/plan.md to notes/roadmap.md. Updated references in 1 file.")).toBeVisible()

  // The open note shows its rewritten link without being reopened.
  await expect(editorText(page)).toContainText("notes/roadmap.md")
  await expect.poll(() => fake.server.content(id, "notes/roadmap.md")).toBe("# Plan\n")
  expect(fake.server.content(id, "notes/plan.md")).toBeUndefined()
  expect(fake.server.content(id, "index.mdx")).toBe("See [the plan](notes/roadmap.md).\n")
  expect(fake.server.content(id, "other.md")).toBe("Unrelated.\n")
  // One save carries the move and the rewrite, so no one ever sees one without the other.
  const sent = saves(fake).slice(before)
  expect(sent).toHaveLength(1)
  expect(sent[0]).toHaveLength(2)
  expect(sent[0]).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ op: "move", path: "notes/plan.md", to: "notes/roadmap.md" }),
      expect.objectContaining({ op: "put", path: "index.mdx", content: "See [the plan](notes/roadmap.md).\n" }),
    ]),
  )
})

test("a D2 diagram moves with its generated files, after a preview that lists what changes", async ({ page }) => {
  const files = {
    "flow.d2": "a -> b\n",
    "flow.excalidraw": SCENE,
    "flow.d2.json": '{"layout":"elk"}\n',
    "page.mdx": '# Page\n\n<Diagram src="flow.d2" />\n',
  }
  const { fake, id } = await openProject(page, files, ["diagrams"], "page.mdx")

  await fileAction(page, "flow.d2", "Move to folder")
  let dialog = page.getByRole("dialog", { name: "Move to folder" })
  await expect(dialog.getByLabel("Destination folder")).toBeFocused()
  await chooseFolder(dialog, "diagrams")
  await dialog.getByRole("button", { name: "Preview move" }).click()
  const preview = dialog.getByRole("region", { name: "Affected files" })
  await expect(preview.getByText("flow.d2 → diagrams/flow.d2", { exact: true })).toBeVisible()
  await expect(preview.getByText("flow.excalidraw → diagrams/flow.excalidraw", { exact: true })).toBeVisible()
  await expect(preview.getByText("flow.d2.json → diagrams/flow.d2.json", { exact: true })).toBeVisible()
  await expect(preview.getByText("Line 3: flow.d2 → diagrams/flow.d2", { exact: true })).toBeVisible()

  // Cancelling changes nothing, and focus returns to the file's row.
  await dialog.getByRole("button", { name: "Cancel" }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole("button", { name: "flow.d2", exact: true })).toBeFocused()
  expect(fake.server.content(id, "flow.d2")).toBe("a -> b\n")

  await fileAction(page, "flow.d2", "Move to folder")
  dialog = page.getByRole("dialog", { name: "Move to folder" })
  await chooseFolder(dialog, "diagrams")
  await dialog.getByRole("button", { name: "Preview move" }).click()
  await dialog.getByRole("button", { name: "Move", exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByText("Moved flow.d2 to diagrams/flow.d2 with its 2 generated files. Updated references in 1 file.")).toBeVisible()

  await expect.poll(() => fake.server.content(id, "diagrams/flow.d2")).toBe(files["flow.d2"])
  expect(fake.server.content(id, "diagrams/flow.excalidraw")).toBe(files["flow.excalidraw"])
  expect(fake.server.content(id, "diagrams/flow.d2.json")).toBe(files["flow.d2.json"])
  for (const path of ["flow.d2", "flow.excalidraw", "flow.d2.json"]) expect(fake.server.content(id, path)).toBeUndefined()
  expect(fake.server.content(id, "page.mdx")).toBe('# Page\n\n<Diagram src="diagrams/flow.d2" />\n')
  await expect(editorText(page)).toContainText("diagrams/flow.d2")
})

test("unsaved edits stop a move until they are saved, then the open tab follows its file", async ({ page }) => {
  const { fake, id } = await openProject(page, { "a.md": "# A\n", "folder/keep.md": "keep\n" }, [], "a.md")
  await editorText(page).click()
  await page.keyboard.press("ControlOrMeta+End")
  await page.keyboard.type("Typed.")

  await fileAction(page, "a.md", "Move to folder")
  const dialog = page.getByRole("dialog", { name: "Move to folder" })
  await chooseFolder(dialog, "folder")
  await dialog.getByRole("button", { name: "Preview move" }).click()
  // Either the kept draft or the open editor reports it, whichever the move sees first.
  await expect(dialog.getByRole("alert")).toHaveText(/^a\.md(:| has) .*unsaved (edits|changes)\. Save or discard them/)
  await expect(dialog.getByRole("button", { name: "Move", exact: true })).toBeDisabled()
  await dialog.getByRole("button", { name: "Cancel" }).click()

  await editorText(page).click()
  await page.keyboard.press("ControlOrMeta+s")
  await expect(page.getByRole("tab", { name: "a.md, unsaved changes" })).toHaveCount(0)
  await fileAction(page, "a.md", "Move to folder")
  await chooseFolder(dialog, "folder")
  await dialog.getByRole("button", { name: "Preview move" }).click()
  await dialog.getByRole("button", { name: "Move", exact: true }).click()
  await expect(dialog).toBeHidden()

  await expect(page.getByRole("tab", { name: "folder/a.md" })).toHaveAttribute("aria-selected", "true")
  await expect(page.getByRole("tab", { name: "a.md", exact: true })).toHaveCount(0)
  await expect(page).toHaveURL(projectUrl(id, "folder/a.md"))
  await expect(editorText(page)).toContainText("# ATyped.")
  await expect.poll(() => fake.server.content(id, "folder/a.md")).toBe("# A\nTyped.")
  expect(fake.server.content(id, "a.md")).toBeUndefined()
})

test("a new folder reaches the server, is still there after a reload, and takes a moved note", async ({ page }) => {
  const { fake, id } = await openProject(page, { "a.md": "# A\n" }, [], "a.md")
  await showExplorer(page)
  const files = page.getByRole("navigation", { name: "Workspace files" })
  await files.getByRole("button", { name: "New folder" }).click()
  await files.getByRole("textbox", { name: "Name of the new folder in the workspace root" }).fill("plans")
  await page.keyboard.press("Enter")
  await expect(page.getByText("Created folder plans.")).toBeVisible()
  await expect.poll(() => fake.server.remote(person.id).folders(id)).toEqual(["plans"])

  await page.reload()
  await expect(page.getByRole("tab", { name: "a.md" })).toBeVisible({ timeout: 15_000 })
  await fileAction(page, "a.md", "Move to folder")
  const move = page.getByRole("dialog", { name: "Move to folder" })
  await chooseFolder(move, "plans")
  await move.getByRole("button", { name: "Preview move" }).click()
  await move.getByRole("button", { name: "Move", exact: true }).click()
  await expect.poll(() => fake.server.content(id, "plans/a.md")).toBe("# A\n")
})

test("a file of a kind the app does not edit is listed and opens as text, but is not renamed or moved", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await openProject(page, { "agent/output.txt": "hello from an agent\n", "notes.md": "# Notes\n" }, [], "notes.md")
  await showExplorer(page)
  const files = page.getByRole("navigation", { name: "Workspace files" })
  await files.getByRole("button", { name: "agent", exact: true, expanded: false }).click()
  await files.getByRole("button", { name: "agent/output.txt", exact: true }).click()
  await expect(page.getByRole("tab", { name: "agent/output.txt" })).toHaveAttribute("aria-selected", "true")
  await expect(editorText(page)).toContainText("hello from an agent")
  await files.getByRole("button", { name: "Actions for agent/output.txt", exact: true }).click()
  await expect(page.getByRole("menuitem", { name: "Copy path" })).toBeVisible()
  await expect(page.getByRole("menuitem", { name: "Rename" })).toHaveCount(0)
  await expect(page.getByRole("menuitem", { name: "Move to folder" })).toHaveCount(0)
  await page.keyboard.press("Escape")
  await files.getByRole("button", { name: "Actions for notes.md", exact: true }).click()
  await expect(page.getByRole("menuitem", { name: "Move to folder" })).toBeVisible()
  expect(errors).toEqual([])
})

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test("the move dialog fits, and axe finds nothing in it", async ({ page }) => {
    // Opened, so its row shows the actions button (a phone's tree shows it on the open file only).
    await openProject(page, { "notes/a.md": "# A\n", "index.md": "[a](notes/a.md)\n" }, ["archive"], "notes/a.md", true)
    await page.getByRole("button", { name: "Back to files and projects" }).click()
    await fileAction(page, "notes/a.md", "Move to folder")
    const dialog = page.getByRole("dialog", { name: "Move to folder" })
    await chooseFolder(dialog, "archive")
    await dialog.getByRole("button", { name: "Preview move" }).click()
    await expect(dialog.getByRole("region", { name: "Affected files" })).toBeVisible()
    const results = await new AxeBuilder({ page }).include(".wb-move").analyze()
    expect(results.violations.map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => node.target) }))).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
    const box = await dialog.boundingBox()
    expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true)
  })
})
