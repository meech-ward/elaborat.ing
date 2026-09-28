import { expect, test, type Page } from "@playwright/test"
import { sectionAnchor, textAnchor } from "../../src/features/comments/placement.ts"
import { FakeProjectServer } from "../../src/features/project-storage/fakeServer.ts"
import { fakeSupabase, person, signedIn, type FakeSupabase } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

// Comments in a note: a selection in Rendered or in Source, or a heading,
// starts a thread from the Comment actions or the comment key; commented text
// is marked in Source (a highlight, and a marker beside its line) and in
// Rendered (a highlight), each placed in the text on screen as it changes;
// markers and highlights open the panel at their thread, and the panel shows
// a thread's text in the note. A thread whose text is deleted is no longer
// marked and shows in the panel with its quote.

test.describe.configure({ timeout: 60_000 })

const PATH = "docs/customer-model.md"
const SOMEONE_ELSE = "5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f"
const NOTE = `# Customer model

How a customer moves from sign-up to their first project, and where agents help.

## Steps

1. Sign up with an email link.
2. Create a project.
`

const FRAME = 'iframe[title="Isolated document preview"]'
const frameOf = (page: Page) => page.frameLocator(FRAME)
const sourceLines = (page: Page) => page.locator(".monaco-editor:visible .view-lines")
/**
 * The text marked as commented in the visible source editor, in reading
 * order (the editor places its lines out of document order, and draws spaces
 * as no-break spaces).
 */
const sourceMarked = (page: Page) =>
  page.locator(".monaco-editor:visible .view-lines .comment-highlight").evaluateAll((spans) =>
    spans
      .map((span) => ({ text: span.textContent ?? "", box: span.getBoundingClientRect() }))
      .sort((a, b) => a.box.top - b.box.top || a.box.left - b.box.left)
      .map(({ text }) => text)
      .join("")
      .replaceAll("\u00a0", " "),
  )
const marker = (page: Page, line: number) => page.getByRole("button", { name: `1 thread on line ${line}`, exact: true })

const panel = (page: Page) => page.getByRole("complementary", { name: "Comments" })
const thread = (page: Page, name: string) => panel(page).getByRole("article", { name: `Comments on ${name}` })
const commentButton = (page: Page) => page.getByRole("button", { name: "Comment", exact: true })

/** Writes a new comment in the panel's draft and sends it. */
async function send(page: Page, body: string) {
  const field = panel(page).getByRole("textbox", { name: "New comment" })
  await expect(field).toBeFocused()
  await field.fill(body)
  await field.press("ControlOrMeta+Enter")
}

/**
 * A project with the note, opened in `view`, with two threads on it unless
 * `threads` is false: one on "where agents help", one on the Steps section.
 */
async function seeded(
  page: Page,
  { threads = true, view = "Split", role }: { threads?: boolean; view?: "Split" | "Source" | "Rendered"; role?: "commenter" | "viewer" } = {},
): Promise<{ fake: FakeSupabase; id: string }> {
  const server = new FakeProjectServer()
  const remote = server.remote(role ? SOMEONE_ELSE : person.id)
  const id = crypto.randomUUID()
  await remote.createProject(id, "Product notes")
  await remote.saveFiles(id, crypto.randomUUID(), [{ op: "put", path: PATH, content: NOTE }])
  if (role) server.share(id, person.id, role)
  const fake = await fakeSupabase(page, { server })
  const fileId = [...fake.server.projects.get(id)!.files.values()].find((file) => file.path === PATH)!.id
  const quote = NOTE.indexOf("where agents help")
  for (const [anchor, body] of [
    [textAnchor(NOTE, quote, quote + "where agents help".length), "Which agents?"],
    [sectionAnchor(NOTE, NOTE.indexOf("## Steps")), "Add a step for inviting a teammate."],
  ] as const) {
    if (threads) fake.comments.call(role ? SOMEONE_ELSE : person.id, "add_comment", { project_id: id, thread_id: crypto.randomUUID(), file_id: fileId, file_version: 1, anchor, body })
  }
  await signedIn(page)
  await page.goto(new URL(`projects/${id}/${PATH}`, APP_URL).href)
  await expect(page.getByRole("tabpanel", { name: PATH })).toBeVisible({ timeout: 15_000 })
  await page.getByRole("button", { name: view, exact: true }).click()
  if (view !== "Source") await expect(frameOf(page).getByRole("heading", { name: "Customer model" })).toBeVisible({ timeout: 15_000 })
  else await expect(sourceLines(page)).toContainText("Customer model")
  return { fake, id }
}

test("commented text is marked in both views and follows edits elsewhere in the note", async ({ page }) => {
  await seeded(page)
  // Source: the quote and the heading line are marked, with a marker beside each line.
  await expect.poll(() => sourceMarked(page)).toBe("where agents help## Steps")
  await expect(marker(page, 3)).toBeVisible()
  await expect(marker(page, 5)).toBeVisible()
  // Rendered: the same words, without the heading's syntax.
  const renderedMarked = frameOf(page).locator(".comment-highlight")
  await expect(renderedMarked).toHaveText(["where agents help", "Steps"])

  // Two lines typed at the top of the source move the marks down with their text.
  await sourceLines(page).click()
  await page.keyboard.press("ControlOrMeta+Home")
  await page.keyboard.type("Read this first.\n\n")
  await expect(marker(page, 5)).toBeVisible()
  await expect(marker(page, 7)).toBeVisible()
  await expect.poll(() => sourceMarked(page)).toBe("where agents help## Steps")
  await expect(frameOf(page).getByText("Read this first.")).toBeVisible()
  await expect(renderedMarked).toHaveText(["where agents help", "Steps"])

  // Words typed in Rendered before the commented text keep it marked too.
  const paragraph = frameOf(page).locator("p").filter({ hasText: "How a customer moves" })
  await paragraph.click({ position: { x: 1, y: 8 } })
  await page.keyboard.type("Today, ")
  await expect(sourceLines(page)).toContainText("Today, How a customer moves")
  await expect(renderedMarked).toHaveText(["where agents help", "Steps"])
  await expect.poll(() => sourceMarked(page)).toBe("where agents help## Steps")
})

test("a thread whose text is deleted is no longer marked", async ({ page }) => {
  await seeded(page)
  await expect(frameOf(page).locator(".comment-highlight")).toHaveCount(2)

  // Delete the line that holds the commented words (a triple click selects the line).
  await sourceLines(page).getByText("How a customer moves").click({ clickCount: 3 })
  await page.keyboard.press("Backspace")
  await expect(sourceLines(page)).not.toContainText("where agents help")

  await expect.poll(() => sourceMarked(page)).toBe("## Steps")
  await expect(frameOf(page).locator(".comment-highlight")).toHaveText(["Steps"])
  await expect(page.getByRole("button", { name: /thread on line 3$/ })).toHaveCount(0)
  await expect(marker(page, 4)).toBeVisible()
})

test("a selection in Source is commented on from its Comment button", async ({ page }) => {
  const { fake } = await seeded(page, { threads: false, view: "Source" })
  await sourceLines(page).getByText("Create a project.").click()
  await page.keyboard.press("End")
  await page.keyboard.press("Shift+Home")
  await commentButton(page).click()
  await send(page, "Name the project first.")

  const created = thread(page, "“2. Create a project.”")
  await expect(created.getByText("Name the project first.")).toBeVisible()
  await expect.poll(() => sourceMarked(page)).toBe("2. Create a project.")
  await expect(marker(page, 8)).toBeVisible()
  expect(fake.comments.threads.map((entry) => entry.anchor)).toMatchObject([
    { kind: "text", quote: { exact: "2. Create a project.", prefix: expect.stringContaining("email link.") } },
  ])
})

test("a selection in Rendered is commented on, and so is a heading pointed at", async ({ page }) => {
  const { fake } = await seeded(page, { threads: false, view: "Rendered" })
  const frame = frameOf(page)
  // Select a list item's words.
  await frame.getByText("Create a project.").click({ position: { x: 1, y: 6 } })
  await page.keyboard.press("Shift+End")
  await commentButton(page).click()
  await send(page, "Name the project first.")
  await expect(thread(page, "“Create a project.”").getByText("Name the project first.")).toBeVisible()
  await expect(frame.locator(".comment-highlight")).toHaveText(["Create a project."])

  // A heading pointed at offers Comment on section.
  await frame.getByRole("heading", { name: "Steps" }).hover()
  await page.getByRole("button", { name: "Comment on section" }).click()
  await send(page, "Add a step for inviting a teammate.")
  await expect(thread(page, "section Steps").getByText("Add a step for inviting a teammate.")).toBeVisible()
  await expect(frame.locator(".comment-highlight")).toHaveText(["Steps", "Create a project."])
  expect(fake.comments.threads.map((entry) => (entry.anchor as { kind: string; quote: { exact: string } }).quote.exact)).toEqual([
    "Create a project.",
    "## Steps",
  ])
})

test("the comment key comments on a heading's section in Source, and elsewhere shows and hides the comments; the context menu comments too", async ({ page }) => {
  await seeded(page, { threads: false, view: "Source" })
  await sourceLines(page).getByText("## Steps").click()
  await page.keyboard.press("ControlOrMeta+Alt+m")
  await send(page, "Add a step for inviting a teammate.")
  await expect(thread(page, "section Steps")).toBeVisible()
  await expect(marker(page, 5)).toBeVisible()

  // On a line that is not a heading, with nothing selected, the key hides the comments.
  await sourceLines(page).getByText("Create a project.").click()
  await page.keyboard.press("ControlOrMeta+Alt+m")
  await expect(panel(page)).toBeHidden()

  // The editor's context menu comments on a selection.
  await page.keyboard.press("End")
  await page.keyboard.press("Shift+Home")
  await sourceLines(page).getByText("Create a project.").click({ button: "right" })
  // The menu shows the key beside it.
  await page.getByRole("menuitem", { name: /^Comment(?! on)/ }).click()
  await send(page, "Name the project first.")
  await expect(thread(page, "“2. Create a project.”")).toBeVisible()
})

test("markers and highlights open the panel at their thread, and the panel shows a thread's text", async ({ page }) => {
  await seeded(page)
  // A marker opens the panel at its thread and gives it the keyboard.
  await marker(page, 5).click()
  const steps = thread(page, "section Steps")
  await expect(steps).toBeFocused()
  await expect(marker(page, 5)).toHaveAttribute("data-active", "true")

  // Commented text clicked in Rendered opens its thread.
  await frameOf(page).locator(".comment-highlight", { hasText: "where agents help" }).click()
  const quote = thread(page, "“where agents help”")
  await expect(frameOf(page).locator(".comment-highlight-active")).toHaveText(["where agents help"])
  await expect(marker(page, 3)).toHaveAttribute("data-active", "true")

  // The panel's quote shows the text in the note: it flashes, and the source takes the keyboard there.
  await steps.getByRole("button", { name: /Steps/ }).first().click()
  await expect(page.locator(".monaco-editor:visible .comment-highlight-flash").first()).toBeVisible()
  await expect(frameOf(page).locator(".comment-highlight-flash")).toHaveText(["Steps"])

  // In Rendered alone, the note takes the keyboard.
  await page.getByRole("button", { name: "Rendered", exact: true }).click()
  await quote.getByRole("button", { name: /where agents help/ }).first().click()
  await expect(frameOf(page).locator(".comment-highlight-flash")).toHaveText(["where agents help"])
  await expect(frameOf(page).getByRole("textbox", { name: "Rendered document" })).toBeFocused()

  // A resolved thread is no longer marked, and its text still shows from the panel.
  await quote.getByRole("button", { name: "Resolve" }).click()
  await expect(frameOf(page).locator(".comment-highlight")).toHaveText(["Steps"])
  await panel(page).getByRole("button", { name: "Resolved 1" }).click()
  await quote.getByRole("button", { name: /where agents help/ }).first().click()
  await expect(frameOf(page).locator(".comment-highlight-flash")).toHaveText(["where agents help"])
})

test("a thread whose text is deleted shows in the panel as detached, with its quote", async ({ page }) => {
  await seeded(page)
  await page.getByRole("button", { name: /^Comments/ }).first().click()
  await expect(thread(page, "“where agents help”")).toBeVisible()
  await sourceLines(page).getByText("How a customer moves").click({ clickCount: 3 })
  await page.keyboard.press("Backspace")
  const detached = panel(page).getByRole("article").filter({ hasText: "Detached" })
  await expect(detached).toContainText("where agents help")
  await expect(detached).toContainText("Which agents?")
})

test("a commenter comments on a note they cannot change, from the comment key in Rendered", async ({ page }) => {
  const { fake } = await seeded(page, { threads: false, view: "Rendered", role: "commenter" })
  const frame = frameOf(page)
  await expect(frame.getByRole("textbox", { name: "Rendered document" })).toHaveAttribute("contenteditable", "false")
  // The caret on a heading, and the comment key: a comment on its section.
  await frame.getByRole("heading", { name: "Steps" }).click()
  await page.keyboard.press("ControlOrMeta+Alt+m")
  await send(page, "Add a step for inviting a teammate.")
  await expect(thread(page, "section Steps")).toBeVisible()
  // A selection (made with the pointer: a note that cannot change has no caret to extend), and the comment key.
  await frame.getByText("Create a project.").click({ clickCount: 3 })
  await page.keyboard.press("ControlOrMeta+Alt+m")
  await send(page, "Name the project first.")
  await expect(thread(page, "“Create a project.”")).toBeVisible()
  expect(fake.comments.threads.map((entry) => entry.createdBy)).toEqual([person.id, person.id])
})

test("a viewer sees commented text but is offered no Comment", async ({ page }) => {
  await seeded(page, { view: "Split", role: "viewer" })
  const frame = frameOf(page)
  await expect(frame.locator(".comment-highlight")).toHaveText(["where agents help", "Steps"])
  await sourceLines(page).getByText("Create a project.").click()
  await page.keyboard.press("End")
  await page.keyboard.press("Shift+Home")
  await frame.getByRole("heading", { name: "Steps" }).hover()
  await expect(commentButton(page)).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Comment on section" })).toHaveCount(0)
})
