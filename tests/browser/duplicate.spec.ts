import { expect, test, type Page } from "@playwright/test"
import { fakeSupabase, person, quiet, signedIn } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

// A file can be duplicated from its menu in the tree, from its File actions,
// from the command palette or with ⌘D / Ctrl+D. The copy is "<name> copy" in the same folder, holds
// what is on screen (unsaved edits too), is saved at once and opens in a new
// tab. A diagram's copy takes its generated files with it. A read-only
// project offers no Duplicate (read-only.spec.ts).

const projectUrl = (id: string, path?: string) => new URL(`projects/${id}${path ? `/${path}` : ""}`, APP_URL).href

// The diagram journey loads D2's WebAssembly build.
test.describe.configure({ timeout: 90_000 })

async function openProject(page: Page, files: Record<string, string>, path: string) {
  const fake = await fakeSupabase(page)
  const remote = fake.server.remote(person.id)
  const id = crypto.randomUUID()
  await remote.createProject(id, "Notes")
  for (const [file, content] of Object.entries(files)) await remote.saveFiles(id, crypto.randomUUID(), [{ op: "put", path: file, content }])
  await signedIn(page)
  await page.goto(projectUrl(id, path))
  await expect(page.getByRole("status").filter({ hasText: "Synced" })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole("tab", { name: path })).toBeVisible()
  return { fake, id }
}

/** Show the explorer (hidden at first on a desktop) and return it. */
async function explorer(page: Page) {
  const toggle = page.getByRole("button", { name: "Toggle explorer" })
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click()
  return page.getByRole("navigation", { name: "Workspace files" }).first()
}

const editorText = (page: Page) => page.locator(".monaco-editor:visible .view-lines").first()

test("Duplicate in a file's menu saves a copy next to it with the same content, and opens it", async ({ page }) => {
  const NOTE = "# A\n\nSome text.\n"
  const { fake, id } = await openProject(page, { "notes/a.md": NOTE, "b.md": "b\n" }, "notes/a.md")
  const files = await explorer(page)

  await files.getByRole("button", { name: "Actions for notes/a.md", exact: true }).click()
  await page.getByRole("menuitem", { name: "Duplicate" }).click()
  await expect(page.getByRole("tab", { name: "notes/a copy.md" })).toHaveAttribute("aria-selected", "true")
  await expect(page.getByText("Duplicated notes/a.md as notes/a copy.md.")).toBeVisible()
  await expect.poll(() => fake.server.content(id, "notes/a copy.md")).toBe(NOTE)
  await expect(editorText(page)).toContainText("Some text.")

  // Again, from a right-click on the row: the next free name.
  await files.getByRole("button", { name: "notes/a.md", exact: true }).click({ button: "right" })
  await page.getByRole("menuitem", { name: "Duplicate" }).click()
  await expect(page.getByRole("tab", { name: "notes/a copy 2.md" })).toHaveAttribute("aria-selected", "true")
  await expect.poll(() => fake.server.content(id, "notes/a copy 2.md")).toBe(NOTE)
  expect(fake.server.content(id, "notes/a.md")).toBe(NOTE)
})

test("⌘D / Ctrl+D duplicates the active note with its unsaved edits and leaves the original as it was", async ({ page }) => {
  const { fake, id } = await openProject(page, { "a.md": "# A\n" }, "a.md")
  await editorText(page).click()
  await page.keyboard.press("ControlOrMeta+End")
  await page.keyboard.type("Edited.")
  await expect(page.getByRole("tab", { name: "a.md" }).getByLabel("unsaved changes")).toBeVisible()
  // In the code editor ⌘D keeps its own meaning (select the next match).
  await page.keyboard.press("ControlOrMeta+d")

  // Anywhere else, such as the file's row in the tree, it duplicates the active file.
  const files = await explorer(page)
  await files.getByRole("button", { name: "a.md", exact: true }).click()
  await page.keyboard.press("ControlOrMeta+d")
  await expect(page.getByRole("tab", { name: "a copy.md" })).toHaveAttribute("aria-selected", "true")
  await expect.poll(() => fake.server.content(id, "a copy.md")).toBe("# A\nEdited.")
  await expect(editorText(page)).toContainText("Edited.")

  // The original is not saved, and still has its unsaved edit.
  await quiet(fake)
  expect(fake.server.paths(id)).toEqual(["a copy.md", "a.md"])
  expect(fake.server.content(id, "a.md")).toBe("# A\n")
  await expect(page.getByRole("tab", { name: "a.md", exact: true }).getByLabel("unsaved changes")).toBeVisible()
})

test("Duplicate in the command palette copies the active file", async ({ page }) => {
  const { fake, id } = await openProject(page, { "a.md": "# A\n" }, "a.md")
  await page.keyboard.press("ControlOrMeta+k")
  await page.getByLabel("Search commands").first().fill("Duplicate")
  await page.keyboard.press("Enter")
  await expect(page.getByRole("tab", { name: "a copy.md" })).toHaveAttribute("aria-selected", "true")
  await expect.poll(() => fake.server.content(id, "a copy.md")).toBe("# A\n")
})

test("a diagram's copy, from File actions, takes its generated files with it", async ({ page }) => {
  const { fake, id } = await openProject(page, { "flow.d2": "a -> b: hello\n" }, "flow.d2")
  await expect(page.getByText("Compiling diagram…")).toHaveCount(0, { timeout: 45_000 })
  await expect(page.locator(".excalidraw canvas").first()).toBeVisible()
  await page.keyboard.press("ControlOrMeta+s")
  await expect.poll(() => fake.server.content(id, "flow.d2.json")).toBeDefined()

  await page.locator(".wb-native-toolbar").getByRole("button", { name: "File actions" }).click()
  await page.getByRole("menuitem", { name: "Duplicate" }).click()
  await expect(page.getByRole("tab", { name: "flow copy.d2" })).toHaveAttribute("aria-selected", "true")
  await expect.poll(() => fake.server.paths(id)).toEqual(["flow copy.d2", "flow copy.d2.json", "flow copy.excalidraw", "flow.d2", "flow.d2.json", "flow.excalidraw"])
  for (const [from, to] of [["flow.d2", "flow copy.d2"], ["flow.excalidraw", "flow copy.excalidraw"], ["flow.d2.json", "flow copy.d2.json"]])
    expect(fake.server.content(id, to), to).toBe(fake.server.content(id, from))
})
