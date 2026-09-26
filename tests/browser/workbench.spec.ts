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
  // On a phone the project header (and its status) is in the navigation sheet.
  if (phone) await expect(page.getByRole("button", { name: "Navigation" }).first()).toBeVisible({ timeout: 15_000 })
  else await expect(page.getByRole("status").filter({ hasText: "Synced" })).toBeVisible({ timeout: 15_000 })
  return { fake, id }
}

const serverContent = (fake: FakeSupabase, id: string, path: string) => fake.server.content(id, path)
const editorText = (page: Page) => page.locator(".monaco-editor:visible .view-lines").first()

/** Put the caret at the end of the visible source editor and type. */
async function typeAtEnd(page: Page, text: string) {
  await editorText(page).click()
  await page.keyboard.press("ControlOrMeta+End")
  await page.keyboard.type(text)
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
  await page.getByRole("menuitem", { name: "Save" }).or(page.getByRole("button", { name: "Save" })).first().click()
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
  const tab = page.getByRole("tab", { name: /^untitled/ })
  await expect(tab).toBeVisible()
  const path = (await tab.getAttribute("aria-label"))!
  await typeAtEnd(page, "A new note.")
  await page.keyboard.press("ControlOrMeta+s")
  await expect.poll(() => serverContent(fake, id, path)).toBe("A new note.")
})

test("open tabs come back after a reload, with the same one active", async ({ page }) => {
  const { id } = await openProject(page, { "a.md": "a\n", "b.md": "b\n" }, "a.md")
  await page.goto(projectUrl(id, "b.md"))
  await expect(page.getByRole("tab", { name: "b.md" })).toHaveAttribute("aria-selected", "true")
  await page.reload()
  await expect(page.getByRole("tab", { name: "a.md" })).toBeVisible()
  await expect(page.getByRole("tab", { name: "b.md" })).toHaveAttribute("aria-selected", "true")
  await expect(page).toHaveURL(projectUrl(id, "b.md"))
})

test("closing a tab from the keyboard works, and an unsaved one asks first", async ({ page }) => {
  await openProject(page, { "a.md": "a\n", "b.md": "b\n" }, "a.md")
  await page.goto(page.url().replace(/a\.md$/, "b.md"))
  await expect(page.getByRole("tab", { name: "b.md" })).toHaveAttribute("aria-selected", "true")
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

  await page.getByRole("tab", { name: "a.md" }).click()
  await typeAtEnd(page, "note")
  await page.keyboard.press("ControlOrMeta+s")
  await expect.poll(() => serverContent(fake, id, "a.md")).toBe("a\nnote")
  // The diagram, which has unsaved generated files, was not saved instead.
  expect(serverContent(fake, id, "flow.excalidraw")).toBeUndefined()

  await page.getByRole("tab", { name: "flow.d2" }).click()
  // No Enter after a name: the suggestions it opens could take the key.
  await typeAtEnd(page, "y -> z")
  await page.keyboard.press("ControlOrMeta+s")
  await expect.poll(() => serverContent(fake, id, "flow.d2")).toBe("x -> y\ny -> z")
  expect(serverContent(fake, id, "a.md")).toBe("a\nnote")
})

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test("files open from the navigation sheet, and nothing scrolls sideways", async ({ page }) => {
    await openProject(page, { "notes/a.md": "# First\n", "notes/b.md": "# On a phone\n" }, undefined, true)
    await page.getByRole("button", { name: "Navigation" }).first().click()
    const sheet = page.getByRole("dialog", { name: "Navigation" })
    await expect(sheet).toBeVisible()
    await expect(sheet.getByRole("status").filter({ hasText: "Synced" })).toBeVisible()
    const expand = sheet.getByRole("button", { name: "Expand notes", exact: true })
    if (await expand.count()) await expand.click()
    await sheet.getByRole("navigation", { name: "Workspace files" }).getByRole("button", { name: "notes/b.md", exact: true }).click()
    await expect(sheet).toBeHidden()
    await expect(editorText(page)).toContainText("# On a phone")
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
  })
})
