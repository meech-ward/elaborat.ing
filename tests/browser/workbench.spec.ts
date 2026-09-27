import AxeBuilder from "@axe-core/playwright"
import { expect, test, type Page } from "@playwright/test"
import { fakeSupabase, person, quiet, signedIn, type FakeSupabase } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

// Editing notes in a project: the source and rendered views, saves on this
// device that sync to the stand-in server, drafts that survive reloads and
// leaving, and a file changed in two places.

const projectUrl = (id: string, path?: string) => new URL(`projects/${id}${path ? `/${path}` : ""}`, APP_URL).href

// Each journey loads the full editor (Monaco and the note frame), which is slow on small CI machines.
test.describe.configure({ timeout: 60_000 })

async function openProject(page: Page, files: Record<string, string>, path?: string, phone = false) {
  const fake = await fakeSupabase(page)
  const remote = fake.server.remote(person.id)
  const id = crypto.randomUUID()
  await remote.createProject(id, "Notes")
  for (const [file, content] of Object.entries(files)) await remote.saveFiles(id, crypto.randomUUID(), [{ op: "put", path: file, content }])
  await signedIn(page)
  await page.goto(projectUrl(id, path))
  // Opening downloads and syncs first, which takes longer on a cold start.
  // On a phone the open file fills the screen; its Back button leads to the files screen.
  if (phone) await expect(page.getByRole("button", { name: "Back to files and projects" })).toBeVisible({ timeout: 15_000 })
  else await expect(page.getByRole("status").filter({ hasText: "Synced" })).toBeVisible({ timeout: 15_000 })
  return { fake, id }
}

const serverContent = (fake: FakeSupabase, id: string, path: string) => fake.server.content(id, path)
/**
 * Wait until the workbench has remembered `path` among its open tabs. It saves
 * them only after its first file list arrives, so a navigation straight after
 * opening a file could otherwise land before `path` was remembered.
 */
async function remembered(page: Page, path: string) {
  await expect
    .poll(() =>
      page.evaluate(
        (path) =>
          Object.keys(localStorage).some(
            (key) => key.endsWith("elaborating.tabs.v1") && (JSON.parse(localStorage.getItem(key) ?? "{}").openPaths ?? []).includes(path),
          ),
        path,
      ),
    )
    .toBe(true)
}

const editorText = (page: Page) => page.locator(".monaco-editor:visible .view-lines").first()

/** Put the caret at the end of the visible source editor and type. */
async function typeAtEnd(page: Page, text: string) {
  await editorText(page).click()
  await page.keyboard.press("ControlOrMeta+End")
  await page.keyboard.type(text)
}

/** Select a file's tab, then type at the end of that tab's own code editor and check the text arrived. */
async function typeInTab(page: Page, path: string, text: string) {
  await page.getByRole("tab", { name: path }).click()
  await expect(page.getByRole("tab", { name: path })).toHaveAttribute("aria-selected", "true")
  const editor = page.getByRole("tabpanel", { name: path }).locator(".monaco-editor:visible .view-lines")
  await editor.click()
  await page.keyboard.press("ControlOrMeta+End")
  await page.keyboard.type(text)
  await expect(editor).toContainText(text)
}

test("typing in the source view saves on this device and reaches the server", async ({ page }) => {
  const { fake, id } = await openProject(page, { "a.md": "# Title\n" }, "a.md")
  await typeAtEnd(page, "Typed here.")
  await expect(page.getByRole("tab", { name: "a.md" }).getByLabel("unsaved changes")).toBeVisible()
  await page.keyboard.press("ControlOrMeta+s")
  await expect(page.getByRole("tab", { name: "a.md" }).getByLabel("unsaved changes")).toHaveCount(0)
  await expect.poll(() => serverContent(fake, id, "a.md")).toBe("# Title\nTyped here.")
})

test("an edit in the rendered view saves to the same file", async ({ page }) => {
  const { fake, id } = await openProject(page, { "a.md": "# Title\n\nFirst paragraph.\n" }, "a.md")
  await page.getByRole("button", { name: "Rendered" }).click()
  const frame = page.frameLocator('iframe[title="Isolated document preview"]')
  const paragraph = frame.locator("p").filter({ hasText: /^First paragraph\.$/ })
  await paragraph.click()
  await page.keyboard.press("End")
  await page.keyboard.type(" More.")
  await expect(frame.locator("p").filter({ hasText: /^First paragraph\. More\.$/ })).toBeVisible()
  await page.getByRole("button", { name: "File actions" }).click()
  await page.getByRole("menuitem", { name: "Save" }).click()
  await expect.poll(() => serverContent(fake, id, "a.md")).toBe("# Title\n\nFirst paragraph. More.\n")
})

test("unsaved edits survive a reload, and are not sent to the server", async ({ page }) => {
  const { fake, id } = await openProject(page, { "a.md": "saved\n" }, "a.md")
  await typeAtEnd(page, "draft")
  await expect(page.getByRole("tab", { name: "a.md" }).getByLabel("unsaved changes")).toBeVisible()
  await page.waitForTimeout(300)
  await page.reload()
  // The reload loads the editor again, as slowly as the first open.
  await expect(page.getByRole("tab", { name: "a.md" }).getByLabel("unsaved changes")).toBeVisible({ timeout: 15_000 })
  await expect(editorText(page)).toContainText("saveddraft")
  expect(serverContent(fake, id, "a.md")).toBe("saved\n")
})

/** Whether leaving the page now would ask first: the app cancels `beforeunload` while a file has unsaved changes. */
const warnsOnLeave = (page: Page) =>
  page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true })
    window.dispatchEvent(event)
    return event.defaultPrevented
  })

test("undoing back to the saved text clears the unsaved state, and a reload restores no draft", async ({ page }) => {
  const { fake, id } = await openProject(page, { "a.md": "saved\n" }, "a.md")
  const mark = page.getByRole("tab", { name: "a.md" }).getByLabel("unsaved changes")
  await typeAtEnd(page, "draft")
  await expect(mark).toBeVisible()
  await expect(page.getByText("Unsaved changes", { exact: true })).toBeVisible()
  expect(await warnsOnLeave(page)).toBe(true)

  await page.keyboard.press("ControlOrMeta+z")
  await expect(editorText(page)).not.toContainText("draft")
  await expect(mark).toHaveCount(0)
  await expect(page.getByText("Unsaved changes", { exact: true })).toHaveCount(0)
  await expect(page).not.toHaveTitle(/^•/)
  expect(await warnsOnLeave(page)).toBe(false)

  // Drafts are kept in the background, as in the journey above.
  await page.waitForTimeout(300)
  await page.reload()
  // The reload loads the editor again, as slowly as the first open.
  await expect(editorText(page)).toContainText("saved", { timeout: 15_000 })
  await expect(editorText(page)).not.toContainText("draft")
  await expect(mark).toHaveCount(0)
  expect(serverContent(fake, id, "a.md")).toBe("saved\n")
})

test("an edit in the rendered view undone with Ctrl+Z there clears the unsaved state, and a reload restores no draft", async ({ page }) => {
  const { fake, id } = await openProject(page, { "a.md": "# Title\n\nFirst paragraph.\n" }, "a.md")
  const mark = page.getByRole("tab", { name: "a.md" }).getByLabel("unsaved changes")
  await page.getByRole("button", { name: "Rendered" }).click()
  const frame = page.frameLocator('iframe[title="Isolated document preview"]')
  const paragraph = frame.locator("p").filter({ hasText: /^First paragraph\./ })
  await paragraph.click()
  await page.keyboard.press("End")
  await page.keyboard.type(" More.")
  await expect(paragraph).toHaveText("First paragraph. More.")
  await expect(mark).toBeVisible()

  await page.keyboard.press("ControlOrMeta+z")
  await expect(paragraph).toHaveText("First paragraph.")
  await expect(mark).toHaveCount(0)
  await expect(page.getByText("Unsaved changes", { exact: true })).toHaveCount(0)
  expect(await warnsOnLeave(page)).toBe(false)

  await page.waitForTimeout(300)
  await page.reload()
  // The note opens in the view it was left in.
  await expect(paragraph).toHaveText("First paragraph.", { timeout: 15_000 })
  await expect(mark).toHaveCount(0)
  expect(serverContent(fake, id, "a.md")).toBe("# Title\n\nFirst paragraph.\n")
})

test("leaving the project keeps unsaved edits, and they are there on return", async ({ page }) => {
  const { fake, id } = await openProject(page, { "a.md": "saved\n" }, "a.md")
  await typeAtEnd(page, "draft")
  await page.getByRole("link", { name: "Your projects" }).click()
  await expect(page.getByRole("heading", { name: "Your projects" })).toBeVisible()
  await page.getByRole("link", { name: "Notes" }).click()
  await expect(page.getByRole("tab", { name: "a.md" }).getByLabel("unsaved changes")).toBeVisible()
  await expect(editorText(page)).toContainText("saveddraft")
  expect(serverContent(fake, id, "a.md")).toBe("saved\n")
})

for (const choice of ["mine", "theirs", "both"] as const) {
  test(`a file changed in two places can keep ${choice}`, async ({ page }) => {
    const { fake, id } = await openProject(page, { "a.md": "base\n" }, "a.md")
    // Save here while the server cannot be reached...
    fake.offline = true
    await typeAtEnd(page, "mine")
    await page.keyboard.press("ControlOrMeta+s")
    await quiet(fake)
    // ...while another device changes the same file.
    const remote = fake.server.remote(person.id)
    const version = fake.server.projects.get(id)!.files.get("a.md")!.version
    await remote.saveFiles(id, crypto.randomUUID(), [{ op: "put", path: "a.md", content: "theirs\n", base_version: version }])
    fake.offline = false
    await page.getByRole("button", { name: "Sync now" }).click()

    await expect(page.getByText("was changed on another device too")).toBeVisible()
    await page.getByRole("button", { name: `Keep ${choice}` }).click()
    if (choice === "mine") {
      await expect.poll(() => serverContent(fake, id, "a.md")).toBe("base\nmine")
    } else if (choice === "theirs") {
      await expect(editorText(page)).toContainText("theirs")
      await expect.poll(() => serverContent(fake, id, "a.md")).toBe("theirs\n")
    } else {
      await expect.poll(() => serverContent(fake, id, "a (my copy).md")).toBe("base\nmine")
      expect(serverContent(fake, id, "a.md")).toBe("theirs\n")
    }
    await expect(page.getByText("was changed on another device too")).toHaveCount(0)
  })
}

test("a new note from the menu is saved under a new name", async ({ page }) => {
  const { fake, id } = await openProject(page, { "a.md": "a\n" })
  await page.getByRole("button", { name: "Workbench menu" }).click()
  await page.getByRole("button", { name: "New", exact: true }).or(page.getByRole("menuitem", { name: "New", exact: true })).first().click()
  // It asks for a name first; Enter takes the one proposed.
  await expect(page.getByRole("textbox", { name: /^Name of the new note in / })).toHaveValue(/^untitled/)
  await page.keyboard.press("Enter")
  const tab = page.getByRole("tab", { name: /^untitled/ })
  await expect(tab).toBeVisible()
  const path = (await tab.getAttribute("aria-label"))!
  await typeAtEnd(page, "A new note.")
  await page.keyboard.press("ControlOrMeta+s")
  await expect.poll(() => serverContent(fake, id, path)).toBe("A new note.")
})

test("open tabs come back after a reload, with the same one active", async ({ page }) => {
  // Three editor loads, each allowed 15 seconds, can outlast the default test time on a busy machine.
  test.slow()
  const { id } = await openProject(page, { "a.md": "a\n", "b.md": "b\n" }, "a.md")
  await remembered(page, "a.md")
  // Each navigation loads the editor again, as slowly as the first open.
  await page.goto(projectUrl(id, "b.md"))
  await expect(page.getByRole("tab", { name: "b.md" })).toHaveAttribute("aria-selected", "true", { timeout: 15_000 })
  await remembered(page, "b.md")
  await page.reload()
  await expect(page.getByRole("tab", { name: "a.md" })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole("tab", { name: "b.md" })).toHaveAttribute("aria-selected", "true")
  await expect(page).toHaveURL(projectUrl(id, "b.md"))
})

test("closing a tab from the keyboard works, and an unsaved one asks first", async ({ page }) => {
  // Two editor loads and a dialog; see the journey above.
  test.slow()
  await openProject(page, { "a.md": "a\n", "b.md": "b\n" }, "a.md")
  await remembered(page, "a.md")
  await page.goto(page.url().replace(/a\.md$/, "b.md"))
  // The navigation loads the editor again, as slowly as the first open.
  await expect(page.getByRole("tab", { name: "b.md" })).toHaveAttribute("aria-selected", "true", { timeout: 15_000 })
  await expect(page.getByRole("tab", { name: "a.md" })).toBeVisible()
  await page.getByRole("tab", { name: "b.md" }).focus()
  await page.keyboard.press("Delete")
  await expect(page.getByRole("tab", { name: "b.md" })).toHaveCount(0)
  await expect(page.getByRole("tab", { name: "a.md" })).toHaveAttribute("aria-selected", "true")

  await typeAtEnd(page, "!")
  page.once("dialog", (dialog) => void dialog.dismiss())
  await page.getByRole("tab", { name: "a.md" }).focus()
  await page.keyboard.press("Delete")
  await expect(page.getByRole("tab", { name: "a.md" })).toBeVisible()
})

/** Open a file from the explorer, in a new tab, without reloading the page. */
async function openFromExplorer(page: Page, path: string) {
  const toggle = page.getByRole("button", { name: "Toggle explorer" })
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click()
  await page.getByRole("button", { name: path, exact: true }).click()
  await expect(page.getByRole("tab", { name: path })).toHaveAttribute("aria-selected", "true")
}

test("Ctrl+S saves the note whose editor has focus, with two notes open", async ({ page }) => {
  const { fake, id } = await openProject(page, { "a.md": "a\n", "b.md": "b\n" }, "a.md")
  // b.md's editor is created second, after a.md's.
  await openFromExplorer(page, "b.md")
  await page.getByRole("tab", { name: "a.md" }).click()
  await typeAtEnd(page, "first")
  await page.keyboard.press("ControlOrMeta+s")
  await expect(page.getByRole("tab", { name: "a.md" }).getByLabel("unsaved changes")).toHaveCount(0)
  await expect.poll(() => serverContent(fake, id, "a.md")).toBe("a\nfirst")

  await page.getByRole("tab", { name: "b.md" }).click()
  await typeAtEnd(page, "second")
  await page.keyboard.press("ControlOrMeta+s")
  await expect.poll(() => serverContent(fake, id, "b.md")).toBe("b\nsecond")
  expect(serverContent(fake, id, "a.md")).toBe("a\nfirst")
})

test("Ctrl+S saves the note whose editor has focus, with a diagram's code open too", async ({ page }) => {
  // The diagram compiles with D2's 8 MB WebAssembly build.
  test.slow()
  const { fake, id } = await openProject(page, { "a.md": "a\n", "flow.d2": "x -> y\n" }, "a.md")
  await openFromExplorer(page, "flow.d2")
  await expect(page.getByText("Compiling diagram…")).toHaveCount(0, { timeout: 45_000 })
  // The code editor is created after the note's.
  await page.getByRole("button", { name: "Code" }).click()
  await expect(page.locator(".monaco-editor:visible")).toBeVisible()

  await typeInTab(page, "a.md", "note")
  await page.keyboard.press("ControlOrMeta+s")
  await expect.poll(() => serverContent(fake, id, "a.md")).toBe("a\nnote")
  // The diagram, which has unsaved generated files, was not saved instead.
  expect(serverContent(fake, id, "flow.excalidraw")).toBeUndefined()

  // No Enter after a name: the suggestions it opens could take the key.
  await typeInTab(page, "flow.d2", "y -> z")
  await page.keyboard.press("ControlOrMeta+s")
  await expect(page.getByRole("tabpanel", { name: "flow.d2" }).getByText("Saved flow.d2 and its generated files.")).toBeVisible()
  await expect.poll(() => serverContent(fake, id, "flow.d2")).toBe("x -> y\ny -> z")
  expect(serverContent(fake, id, "a.md")).toBe("a\nnote")
})

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test("files open from the files screen, and nothing scrolls sideways", async ({ page }) => {
    await openProject(page, { "notes/a.md": "# First\n", "notes/b.md": "# On a phone\n" }, undefined, true)
    await page.getByRole("button", { name: "Back to files and projects" }).click()
    const screen = page.getByRole("region", { name: "Files and projects" })
    await expect(screen).toBeVisible()
    await expect(screen.getByRole("status").filter({ hasText: "Synced" })).toBeVisible()
    const expand = screen.getByRole("button", { name: "Expand notes", exact: true })
    if (await expand.count()) await expand.click()
    await screen.getByRole("navigation", { name: "Workspace files" }).getByRole("button", { name: "notes/b.md", exact: true }).click()
    await expect(screen).toBeHidden()
    await expect(editorText(page)).toContainText("# On a phone")
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
  })

  test("Save shows only with unsaved edits and saves, and Back keeps the file open", async ({ page }) => {
    const { fake, id } = await openProject(page, { "a.md": "# Title\n" }, "a.md", true)
    const save = page.getByRole("button", { name: "Save", exact: true })
    await expect(save).toHaveCount(0)
    await typeAtEnd(page, "Typed on a phone.")
    await save.click()
    await expect.poll(() => serverContent(fake, id, "a.md")).toBe("# Title\nTyped on a phone.")
    await expect(save).toHaveCount(0)

    await page.getByRole("button", { name: "Rendered" }).click()
    await expect(page.getByRole("button", { name: "Rendered" })).toHaveAttribute("aria-pressed", "true")
    await page.getByRole("button", { name: "Source" }).click()
    await expect(editorText(page)).toContainText("Typed on a phone.")

    await page.getByRole("button", { name: "Back to files and projects" }).click()
    const screen = page.getByRole("region", { name: "Files and projects" })
    const open = screen.getByRole("region", { name: "Open files" }).getByRole("button", { name: "a.md", exact: true })
    await expect(open).toBeVisible()
    // Axe finds nothing on the files screen, in light and in dark.
    for (let scheme = 0; scheme < 2; scheme++) {
      const results = await new AxeBuilder({ page }).include(".wb-files-screen").analyze()
      expect(results.violations.map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => node.target) }))).toEqual([])
      await screen.getByRole("button", { name: /^Switch to (dark|light) mode$/ }).click()
    }
    await open.click()
    await expect(screen).toBeHidden()
    await expect(editorText(page)).toContainText("Typed on a phone.")
  })
})
