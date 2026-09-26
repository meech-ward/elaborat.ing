import AxeBuilder from "@axe-core/playwright"
import { expect, test, type Page } from "@playwright/test"
import { fakeSupabase, person, signedIn, type FakeSupabase } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

// Folders and files in the explorer: new folders, and renames and moves whose
// references are rewritten in the same save. A D2 diagram's generated files go
// with it, open tabs follow their files, and unsaved edits stop a move until
// they are saved.

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
  if (phone) await expect(page.getByRole("button", { name: "Navigation" }).first()).toBeVisible({ timeout: 15_000 })
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
  const toggle = page.getByRole("button", { name: "Toggle explorer" })
  if ((await toggle.isVisible()) && (await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click()
  const files = page.getByRole("navigation", { name: "Workspace files" }).first()
  const parts = path.split("/").slice(0, -1)
  for (let i = 1; i <= parts.length; i++) {
    const expand = files.getByRole("button", { name: `Expand ${parts.slice(0, i).join("/")}`, exact: true })
    if (await expand.count()) await expand.click()
  }
  await files.getByRole("button", { name: `Actions for ${path}`, exact: true }).click()
  await page.getByRole("menuitem", { name: action }).click()
}

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
  await dialog.getByLabel("Destination folder").selectOption("diagrams")
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
  await dialog.getByLabel("Destination folder").selectOption("diagrams")
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
  await dialog.getByLabel("Destination folder").selectOption("folder")
  await dialog.getByRole("button", { name: "Preview move" }).click()
  // Either the kept draft or the open editor reports it, whichever the move sees first.
  await expect(dialog.getByRole("alert")).toHaveText(/^a\.md(:| has) .*unsaved (edits|changes)\. Save or discard them/)
  await expect(dialog.getByRole("button", { name: "Move", exact: true })).toBeDisabled()
  await dialog.getByRole("button", { name: "Cancel" }).click()

  await editorText(page).click()
  await page.keyboard.press("ControlOrMeta+s")
  await expect(page.getByRole("tab", { name: "a.md" }).getByLabel("unsaved changes")).toHaveCount(0)
  await fileAction(page, "a.md", "Move to folder")
  await dialog.getByLabel("Destination folder").selectOption("folder")
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
  await page.getByRole("button", { name: "Toggle explorer" }).click()
  const files = page.getByRole("navigation", { name: "Workspace files" })
  await files.getByRole("button", { name: "New folder" }).click()
  const dialog = page.getByRole("dialog", { name: /^New folder in/ })
  await dialog.getByLabel("Folder name").fill("plans")
  await dialog.getByRole("button", { name: "Create folder" }).click()
  await expect(page.getByText("Created folder plans.")).toBeVisible()
  await expect.poll(() => fake.server.remote(person.id).folders(id)).toEqual(["plans"])

  await page.reload()
  await expect(page.getByRole("tab", { name: "a.md" })).toBeVisible({ timeout: 15_000 })
  await fileAction(page, "a.md", "Move to folder")
  const move = page.getByRole("dialog", { name: "Move to folder" })
  await move.getByLabel("Destination folder").selectOption("plans")
  await move.getByRole("button", { name: "Preview move" }).click()
  await move.getByRole("button", { name: "Move", exact: true }).click()
  await expect.poll(() => fake.server.content(id, "plans/a.md")).toBe("# A\n")
})

test("a file of a kind the app does not edit is listed and opens as text, but is not renamed or moved", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await openProject(page, { "agent/output.txt": "hello from an agent\n", "notes.md": "# Notes\n" }, [], "notes.md")
  await page.getByRole("button", { name: "Toggle explorer" }).click()
  const files = page.getByRole("navigation", { name: "Workspace files" })
  await files.getByRole("button", { name: "Expand agent", exact: true }).click()
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
    await openProject(page, { "notes/a.md": "# A\n", "index.md": "[a](notes/a.md)\n" }, ["archive"], undefined, true)
    await page.getByRole("button", { name: "Navigation" }).first().click()
    await fileAction(page, "notes/a.md", "Move to folder")
    const dialog = page.getByRole("dialog", { name: "Move to folder" })
    await dialog.getByLabel("Destination folder").selectOption("archive")
    await dialog.getByRole("button", { name: "Preview move" }).click()
    await expect(dialog.getByRole("region", { name: "Affected files" })).toBeVisible()
    const results = await new AxeBuilder({ page }).include(".wb-move").analyze()
    expect(results.violations.map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => node.target) }))).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
    const box = await dialog.boundingBox()
    expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true)
  })
})
