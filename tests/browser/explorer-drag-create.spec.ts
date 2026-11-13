import { expect, test, type Page } from "./fixtures.ts"
import { fakeSupabase, person, quiet, signedIn, type FakeSupabase } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

// Explorer moves use the same revision-checked save and reference rewriting
// as the Move dialog. Creation follows the latest selected folder or file.
test.use({ viewport: { width: 1280, height: 900 } })
test.describe.configure({ timeout: 60_000 })

const projectUrl = (id: string, path?: string) => new URL(`projects/${id}${path ? `/${path}` : ""}`, APP_URL).href
const explorer = (page: Page) => page.getByRole("navigation", { name: "Workspace files" }).first()
const file = (page: Page, path: string) => explorer(page).getByRole("button", { name: path, exact: true })
const source = (page: Page) => page.locator(".monaco-editor:visible .view-lines").first()
const SOMEONE_ELSE = "5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f"

async function openProject(page: Page, options: { files: Record<string, string>; folders?: string[]; path?: string; viewer?: boolean; phone?: boolean }) {
  const fake = await fakeSupabase(page)
  const remote = fake.server.remote(options.viewer ? SOMEONE_ELSE : person.id)
  const id = crypto.randomUUID()
  await remote.createProject(id, "Explorer actions")
  for (const path of options.folders ?? []) await remote.saveFiles(id, crypto.randomUUID(), [{ op: "mkdir", path }])
  for (const [path, content] of Object.entries(options.files)) await remote.saveFiles(id, crypto.randomUUID(), [{ op: "put", path, content }])
  if (options.viewer) fake.server.share(id, person.id, "viewer")
  await signedIn(page)
  await page.goto(projectUrl(id, options.path))
  if (options.phone) {
    await expect(page.getByRole("button", { name: "Back to files and projects" })).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole("tabpanel", { name: options.path ?? Object.keys(options.files).sort()[0], exact: true })).toBeVisible({ timeout: 15_000 })
  } else {
    await expect(explorer(page)).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole("tab", { name: options.path ?? Object.keys(options.files).sort()[0], exact: true })).toBeVisible({ timeout: 15_000 })
  }
  return { fake, id }
}

async function expandTo(page: Page, path: string) {
  const parts = path.split("/")
  for (let index = 1; index <= parts.length; index++) {
    const folder = file(page, parts.slice(0, index).join("/"))
    await expect(folder).toBeVisible()
    if (await folder.getAttribute("aria-expanded") === "false") await folder.click()
  }
}

const saves = (fake: FakeSupabase) => fake.requests.filter((request) => request.url().endsWith("/rpc/save_files"))

test("dragging a file into a nested folder saves its references and open tab, survives reload, and can return to the root", async ({ page }) => {
  const note = "# Draft\n\nKeep these words.\n"
  const { fake, id } = await openProject(page, {
    files: { "draft.md": note, "index.mdx": "See [the draft](draft.md).\n" },
    folders: ["archive/2026"], path: "draft.md",
  })
  await expandTo(page, "archive")
  const before = saves(fake).length
  await expect(file(page, "draft.md")).toHaveAttribute("draggable", "true")
  await file(page, "draft.md").dragTo(file(page, "archive/2026"))
  await expect(page.getByRole("tab", { name: "archive/2026/draft.md", exact: true })).toHaveAttribute("aria-selected", "true")
  await expect(page.getByRole("tab", { name: "draft.md", exact: true })).toHaveCount(0)
  await expect(page).toHaveURL(projectUrl(id, "archive/2026/draft.md"))
  await expect(source(page)).toContainText("Keep these words.")
  await expect.poll(() => fake.server.paths(id)).toEqual(["archive/2026/draft.md", "index.mdx"])
  expect(fake.server.content(id, "archive/2026/draft.md")).toBe(note)
  expect(fake.server.content(id, "index.mdx")).toBe("See [the draft](archive/2026/draft.md).\n")
  const sent = saves(fake).slice(before)
  expect(sent).toHaveLength(1)
  expect((sent[0].postDataJSON() as { changes: unknown[] }).changes).toEqual(expect.arrayContaining([
    expect.objectContaining({ op: "move", path: "draft.md", to: "archive/2026/draft.md" }),
    expect.objectContaining({ op: "put", path: "index.mdx", content: "See [the draft](archive/2026/draft.md).\n" }),
  ]))
  await page.reload()
  await expect(page.getByRole("tab", { name: "archive/2026/draft.md", exact: true })).toHaveAttribute("aria-selected", "true", { timeout: 15_000 })
  await expect(source(page)).toContainText("Keep these words.")
  await expect(file(page, "archive/2026/draft.md")).toBeVisible()
  await file(page, "archive/2026/draft.md").dragTo(explorer(page).getByRole("button", { name: "Project root", exact: true }))
  await expect(page.getByRole("tab", { name: "draft.md", exact: true })).toHaveAttribute("aria-selected", "true")
  await expect.poll(() => fake.server.content(id, "draft.md")).toBe(note)
  expect(fake.server.content(id, "index.mdx")).toBe("See [the draft](draft.md).\n")
})

test("a native drawing can be dropped into a folder, reloaded without its old path, and moved back", async ({ page }) => {
  const drawing = JSON.stringify({ type: "excalidraw", version: 2, elements: [], appState: {}, files: {} })
  const { fake, id } = await openProject(page, { files: { "sketch.excalidraw": drawing }, folders: ["archive"], path: "sketch.excalidraw" })
  const canvas = page.locator(".excalidraw canvas").first()
  await expect(canvas).toBeVisible({ timeout: 15_000 })
  await file(page, "sketch.excalidraw").dragTo(file(page, "archive"))
  await expect(page.getByRole("tab", { name: "archive/sketch.excalidraw", exact: true })).toHaveAttribute("aria-selected", "true")
  await expect.poll(() => fake.server.paths(id)).toEqual(["archive/sketch.excalidraw"])
  expect(fake.server.content(id, "archive/sketch.excalidraw")).toBe(drawing)
  await page.reload()
  await expect(canvas).toBeVisible({ timeout: 15_000 })
  await expect(file(page, "archive/sketch.excalidraw")).toBeVisible()
  await expect(file(page, "sketch.excalidraw")).toHaveCount(0)
  await file(page, "archive/sketch.excalidraw").dragTo(explorer(page).getByRole("button", { name: "Project root", exact: true }))
  await expect(page.getByRole("tab", { name: "sketch.excalidraw", exact: true })).toHaveAttribute("aria-selected", "true")
  await expect.poll(() => fake.server.paths(id)).toEqual(["sketch.excalidraw"])
  expect(fake.server.content(id, "sketch.excalidraw")).toBe(drawing)
  await quiet(fake)
  await expect(file(page, "archive/sketch.excalidraw")).toHaveCount(0)
})

test("dragging refuses a taken destination and unsaved edits without changing files", async ({ page, appErrors }) => {
  const { fake, id } = await openProject(page, {
    files: { "draft.md": "# Original\n", "archive/draft.md": "# Existing copy\n" },
    folders: ["later"], path: "draft.md",
  })
  appErrors.expect("Move refused:")
  const before = saves(fake).length
  await file(page, "draft.md").dragTo(file(page, "archive"))
  await expect(page.getByText("Move refused: archive/draft.md already exists.", { exact: true })).toBeVisible()
  await source(page).click()
  await page.keyboard.press("ControlOrMeta+End")
  await page.keyboard.type("Unsaved words.")
  await expect(page.getByRole("tab", { name: "draft.md, unsaved changes", exact: true })).toBeVisible()
  await file(page, "draft.md").dragTo(file(page, "later"))
  await expect(page.getByText(/^Move refused: .*unsaved (edits|changes)\. Save or discard them/)).toBeVisible()
  await expect(source(page)).toContainText("Unsaved words.")
  await quiet(fake)
  expect(saves(fake)).toHaveLength(before)
  expect(fake.server.paths(id)).toEqual(["archive/draft.md", "draft.md"])
  expect(fake.server.content(id, "draft.md")).toBe("# Original\n")
  expect(fake.server.content(id, "archive/draft.md")).toBe("# Existing copy\n")
})

test("a viewer cannot drag files or create files in a shared project", async ({ page }) => {
  const { fake, id } = await openProject(page, { files: { "draft.md": "# Shared\n" }, folders: ["archive"], path: "draft.md", viewer: true })
  await expect(page.getByRole("banner").getByText("You can view this project but not change it.")).toBeVisible()
  await expect(file(page, "draft.md")).not.toHaveAttribute("draggable", "true")
  await file(page, "draft.md").dragTo(file(page, "archive"))
  await expect(page.getByRole("button", { name: "New file", exact: true })).toHaveCount(0)
  await quiet(fake)
  expect(saves(fake)).toHaveLength(0)
  expect(fake.server.paths(id)).toEqual(["draft.md"])
})

const kinds = [
  { noun: "note", item: "New note", name: "new-note.mdx" },
  { noun: "drawing", item: "New drawing", name: "new-drawing.excalidraw" },
  { noun: "diagram", item: "New diagram", name: "new-diagram.d2" },
]

async function startNew(page: Page, kind: { noun: string; item: string }, directory: string) {
  await page.getByRole("button", { name: "New file", exact: true }).click()
  await page.getByRole("menuitem", { name: kind.item, exact: true }).click()
  const field = page.getByRole("textbox", { name: `Name of the new ${kind.noun} in ${directory || "the workspace root"}`, exact: true })
  await expect(field).toBeFocused()
  return field
}

for (const kind of kinds) test(`a new ${kind.noun} is created inside the explicitly selected nested folder`, async ({ page }) => {
  const { fake, id } = await openProject(page, { files: { "index.md": "# Index\n" }, folders: ["docs/deep"], path: "index.md" })
  await expandTo(page, "docs")
  await file(page, "docs/deep").click()
  const field = await startNew(page, kind, "docs/deep")
  await field.fill(kind.name)
  await field.press("Enter")
  await expect(field).toHaveCount(0)
  await expect(page.getByRole("tab", { name: `docs/deep/${kind.name}`, exact: true })).toHaveAttribute("aria-selected", "true")
  await expect.poll(() => fake.server.content(id, `docs/deep/${kind.name}`)).not.toBeUndefined()
  expect(fake.server.content(id, kind.name)).toBeUndefined()
})

test("selecting a file or an existing tab chooses its parent, and a root file resets creation to the root", async ({ page }) => {
  const { fake, id } = await openProject(page, {
    files: { "index.md": "# Index\n", "docs/deep/source.md": "# Source\n" }, folders: ["archive"], path: "index.md",
  })
  await expandTo(page, "docs/deep")
  await file(page, "archive").click()
  await file(page, "docs/deep/source.md").click()
  await expect(page.getByRole("tab", { name: "docs/deep/source.md", exact: true })).toHaveAttribute("aria-selected", "true")
  let field = await startNew(page, kinds[0], "docs/deep")
  await field.fill("sibling.mdx")
  await field.press("Enter")
  await expect.poll(() => fake.server.content(id, "docs/deep/sibling.mdx")).not.toBeUndefined()
  await file(page, "docs/deep").click()
  await file(page, "index.md").click()
  field = await startNew(page, kinds[0], "")
  await field.fill("root-note.mdx")
  await field.press("Enter")
  await expect.poll(() => fake.server.content(id, "root-note.mdx")).not.toBeUndefined()
  // An already open tab is a fresh selection even after another folder was chosen.
  await file(page, "archive").click()
  await page.getByRole("tab", { name: "docs/deep/source.md", exact: true }).click()
  field = await startNew(page, kinds[1], "docs/deep")
  await field.fill("from-tab.excalidraw")
  await field.press("Enter")
  await expect.poll(() => fake.server.content(id, "docs/deep/from-tab.excalidraw")).not.toBeUndefined()
  expect(fake.server.paths(id).filter((path) => path.startsWith("archive/"))).toEqual([])
  // Clicking the current tab also selects its file after a folder selection.
  await file(page, "archive").click()
  await page.getByRole("tab", { name: "docs/deep/from-tab.excalidraw", exact: true }).click()
  field = await startNew(page, kinds[2], "docs/deep")
  await field.press("Escape")
  await expect(field).toHaveCount(0)
})

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test("a selected nested folder becomes the new note dialog's destination", async ({ page }) => {
    const { fake, id } = await openProject(page, { files: { "index.md": "# Index\n" }, folders: ["docs/deep"], path: "index.md", phone: true })
    await page.getByRole("button", { name: "Back to files and projects" }).click()
    await expandTo(page, "docs")
    await file(page, "docs/deep").click()
    await page.getByRole("button", { name: "New file", exact: true }).click()
    await page.getByRole("menuitem", { name: "New note", exact: true }).click()
    const dialog = page.getByRole("dialog", { name: "New note in docs/deep", exact: true })
    await expect(dialog.getByLabel("Name", { exact: true })).toBeFocused()
    await dialog.getByLabel("Name", { exact: true }).fill("phone-note.mdx")
    await dialog.getByRole("button", { name: "Create", exact: true }).click()
    await expect(dialog).toBeHidden()
    await expect.poll(() => fake.server.content(id, "docs/deep/phone-note.mdx")).not.toBeUndefined()
    await expect(page.getByRole("button", { name: "Back to files and projects" })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
  })
})
