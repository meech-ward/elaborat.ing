import { expect, test, type Page } from "@playwright/test"
import AxeBuilder from "./axe.ts"
import { textAnchor } from "../../src/features/comments/placement.ts"
import { FakeProjectServer } from "../../src/features/project-storage/fakeServer.ts"
import { fakeSupabase, person, signedIn, type FakeSupabase } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

// The comments panel beside the open file: its toggle and shortcut, whole
// note comments, replies, resolving and reopening, edits and deletes by
// role, a viewer's and an offline reader's panel, comments arriving from
// elsewhere, and the phone's sheet.

test.describe.configure({ timeout: 60_000 })

const projectUrl = (id: string, path?: string) => new URL(`projects/${id}${path ? `/${path}` : ""}`, APP_URL).href
const SOMEONE_ELSE = "5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f"
const NOTE = "# Plan\n\nShip the comments panel first.\n\n## Steps\n\nThen the markers.\n"

type Opened = { fake: FakeSupabase; id: string; server: FakeProjectServer }

/**
 * A project with notes/plan.md, owned by the person (or shared with them as
 * `role`), opened on the note. `comments` are someone else's, on the whole
 * note, there before the page opens.
 */
async function openNote(page: Page, { role, comments = [] }: { role?: "viewer" | "commenter"; comments?: string[] } = {}): Promise<Opened> {
  const server = new FakeProjectServer()
  server.emails.set(SOMEONE_ELSE, "ada@example.com")
  const owner = server.remote(role ? SOMEONE_ELSE : person.id)
  const id = crypto.randomUUID()
  await owner.createProject(id, "Plans")
  await owner.saveFiles(id, crypto.randomUUID(), [{ op: "put", path: "notes/plan.md", content: NOTE }])
  // Someone else comments too: the owner, or a commenter on the person's project.
  if (role) server.share(id, person.id, role)
  else server.share(id, SOMEONE_ELSE, "commenter")
  const fake = await fakeSupabase(page, { server })
  for (const body of comments) commentAsSomeoneElse(fake, id, body)
  await signedIn(page)
  await page.goto(projectUrl(id, "notes/plan.md"))
  // The comments button shows once the note is open (on a desktop in its top line, on a phone over it).
  await expect(page.getByRole("button", { name: /^Comments(, \d+ open)?$/ })).toBeVisible({ timeout: 15_000 })
  return { fake, id, server }
}

/** A whole note comment from someone else, written as another device would. */
function commentAsSomeoneElse(fake: FakeSupabase, id: string, body: string) {
  const file = fake.server.projects.get(id)!.files.get("notes/plan.md")!
  fake.comments.call(SOMEONE_ELSE, "add_comment", {
    project_id: id,
    thread_id: crypto.randomUUID(),
    file_id: file.id,
    file_version: file.version,
    anchor: { kind: "document" },
    body,
  })
}

const panel = (page: Page) => page.getByRole("complementary", { name: "Comments" })
const toggle = (page: Page) => page.getByRole("button", { name: /^Comments(, \d+ open)?$/ })
const thread = (page: Page, name: string | RegExp) => panel(page).getByRole("article", { name })
/** What the panel last read out. */
const announced = (page: Page) => panel(page).locator('p[role="status"]')

test("a whole note comment is added, replied to, resolved, reopened, edited and deleted", async ({ page }) => {
  const { fake } = await openNote(page)
  await toggle(page).click()
  await expect(panel(page)).toBeVisible()
  await expect(panel(page).getByText("No comments yet")).toBeVisible()
  await expect(new AxeBuilder({ page }).include('aside[aria-label="Comments"]').analyze().then((result) => result.violations)).resolves.toEqual([])

  // A new thread on the whole note, from the panel.
  await panel(page).getByRole("button", { name: "Comment on the whole note" }).first().click()
  const field = panel(page).getByRole("textbox", { name: "New comment" })
  await expect(field).toBeFocused()
  await field.fill("Is the plan still current?")
  await field.press("ControlOrMeta+Enter")
  const whole = thread(page, "Comments on Whole note")
  await expect(whole.getByText("Is the plan still current?")).toBeVisible()
  await expect(toggle(page)).toHaveAccessibleName("Comments, 1 open")
  await expect(announced(page)).toHaveText("Comment added")
  expect(fake.comments.comments.map((comment) => comment.body)).toEqual(["Is the plan still current?"])

  // A reply.
  await whole.getByRole("button", { name: "Reply" }).click()
  await whole.getByRole("textbox", { name: "Reply" }).fill("Yes, until Friday.")
  await whole.getByRole("textbox", { name: "Reply" }).press("ControlOrMeta+Enter")
  await expect(whole.getByRole("paragraph").filter({ hasText: "Yes, until Friday." })).toBeVisible()
  await expect(whole.getByRole("textbox", { name: "Reply" })).toHaveValue("")
  await expect(announced(page)).toHaveText("Reply sent")

  // Edit the reply: Save waits for a change, then the words change.
  await whole.getByRole("button", { name: `Actions for the comment by ${person.email}` }).last().click()
  await page.getByRole("menuitem", { name: "Edit" }).click()
  const edit = whole.getByRole("textbox", { name: "Edit comment" })
  await expect(edit).toBeFocused()
  await expect(whole.getByRole("button", { name: /^Save/ })).toBeDisabled()
  await edit.fill("Yes, until Monday.")
  await whole.getByRole("button", { name: /^Save/ }).click()
  await expect(whole.getByText("Yes, until Monday.")).toBeVisible()
  await expect(whole.getByText("edited")).toBeVisible()

  // Resolve folds it under Resolved, and Reopen brings it back.
  await whole.getByRole("button", { name: "Resolve" }).click()
  await expect(whole).toBeHidden()
  await expect(toggle(page)).toHaveAccessibleName("Comments")
  await panel(page).getByRole("button", { name: "Resolved 1" }).click()
  await expect(whole.getByText(`Resolved by ${person.email}`)).toBeVisible()
  await whole.getByRole("button", { name: "Reopen" }).click()
  await expect(toggle(page)).toHaveAccessibleName("Comments, 1 open")
  expect(fake.comments.threads.length).toBe(1)

  // Deleting the reply leaves the thread; deleting the last comment takes it.
  await whole.getByRole("button", { name: `Actions for the comment by ${person.email}` }).last().click()
  await page.getByRole("menuitem", { name: "Delete" }).click()
  await expect(whole.getByText("Yes, until Monday.")).toBeHidden()
  await expect(whole.getByText("Comment deleted")).toBeVisible()
  await whole.getByRole("button", { name: `Actions for the comment by ${person.email}` }).click()
  await page.getByRole("menuitem", { name: "Delete" }).click()
  await expect(whole).toBeHidden()
  await expect(panel(page).getByText("No comments yet")).toBeVisible()
  expect(fake.comments.threads.length).toBe(0)
})

test("the shortcut shows the panel and focus goes back to the toggle when it closes", async ({ page }) => {
  await openNote(page)
  await expect(toggle(page)).toBeVisible()
  await page.keyboard.press("ControlOrMeta+Alt+m")
  await expect(panel(page)).toBeFocused()
  await panel(page).getByRole("button", { name: "Close comments" }).click()
  await expect(panel(page)).toBeHidden()
  await expect(toggle(page)).toBeFocused()
  await page.keyboard.press("ControlOrMeta+Alt+m")
  await expect(panel(page)).toBeVisible()
  await page.keyboard.press("ControlOrMeta+Alt+m")
  await expect(panel(page)).toBeHidden()
})

test("a marker in the note opens the panel at its thread, with the keyboard on it", async ({ page }) => {
  const { fake, id } = await openNote(page)
  const file = fake.server.projects.get(id)!.files.get("notes/plan.md")!
  const start = NOTE.indexOf("Ship the comments panel first.")
  fake.comments.call(person.id, "add_comment", {
    project_id: id,
    thread_id: crypto.randomUUID(),
    file_id: file.id,
    file_version: file.version,
    anchor: textAnchor(NOTE, start, start + "Ship the comments panel first.".length),
    body: "Before the markers?",
  })
  // The list was read when the note opened: a change signal brings the new thread.
  fake.signal(id, fake.server.projects.get(id)!.revision)
  const marker = page.getByRole("button", { name: "1 thread on line 3", exact: true })
  await expect(marker).toBeVisible()
  await marker.press("Enter")
  const opened = thread(page, /^Comments on “Ship the comments panel first\.”/)
  await expect(opened).toBeFocused()
  await expect(opened).toHaveAttribute("data-active", "true")
})

test("the owner deletes someone else's comment but cannot edit it; a comment from elsewhere arrives live", async ({ page }) => {
  const { fake, id, server } = await openNote(page, { comments: ["Please add dates."] })
  await toggle(page).click()
  const whole = thread(page, "Comments on Whole note").filter({ hasText: "Please add dates." })
  await expect(whole).toBeVisible()

  // Another comment arrives from elsewhere, with the project's change signal.
  commentAsSomeoneElse(fake, id, "And owners.")
  fake.signal(id, server.projects.get(id)!.revision)
  await expect(panel(page).getByText("And owners.")).toBeVisible()
  await expect(announced(page)).toHaveText("1 new comment")

  const menu = whole.getByRole("button", { name: "Actions for the comment by ada@example.com" })
  await menu.click()
  await expect(page.getByRole("menuitem", { name: "Edit" })).toHaveCount(0)
  await page.getByRole("menuitem", { name: "Delete" }).click()
  await expect(whole).toBeHidden()
  await expect(panel(page).getByText("Please add dates.")).toBeHidden()
})

test("a viewer reads comments and cannot write them", async ({ page }) => {
  await openNote(page, { role: "viewer", comments: ["Reviewed."] })
  await toggle(page).click()
  await expect(panel(page).getByText("Reviewed.")).toBeVisible()
  await expect(panel(page).getByText("You can read comments. Writing them needs commenter access.")).toBeVisible()
  for (const name of ["Reply", "Resolve", "Comment on the whole note", "Actions for the comment by ada@example.com"]) {
    await expect(panel(page).getByRole("button", { name })).toHaveCount(0)
  }
  await expect(new AxeBuilder({ page }).include('aside[aria-label="Comments"]').analyze().then((result) => result.violations)).resolves.toEqual([])
})

test("offline, the panel says comments need a connection and offers no writing", async ({ page }) => {
  const { fake } = await openNote(page, { comments: ["Still true?"] })
  await toggle(page).click()
  await expect(panel(page).getByText("Still true?")).toBeVisible()
  fake.offline = true
  // The app notices the connection is gone on its next refresh.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")))
  await expect(panel(page).getByText("Comments need a connection. These may be out of date.")).toBeVisible()
  await expect(panel(page).getByRole("button", { name: "Reply" })).toHaveCount(0)
  await expect(panel(page).getByRole("button", { name: "Comment on the whole note" })).toHaveCount(0)
})

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test("the comments open in a sheet from the bottom", async ({ page }) => {
    await openNote(page, { comments: ["Looks good."] })
    const button = page.getByRole("button", { name: /^Comments/ })
    await expect(button).toBeVisible()
    await button.click()
    const sheet = page.getByRole("dialog", { name: "Comments" })
    await expect(sheet).toBeVisible()
    await expect(sheet.getByRole("button", { name: "Close comments" })).toBeFocused()
    await expect(sheet.getByText("Looks good.")).toBeVisible()
    const reply = await sheet.getByRole("button", { name: "Reply" }).boundingBox()
    expect(reply?.height).toBeGreaterThanOrEqual(40)
    await page.keyboard.press("Escape")
    await expect(sheet).toBeHidden()
  })
})
