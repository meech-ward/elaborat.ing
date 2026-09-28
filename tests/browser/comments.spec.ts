import { expect, test, type Page } from "@playwright/test"
import AxeBuilder from "./axe.ts"
import { textAnchor } from "../../src/features/comments/placement.ts"
import { FakeProjectServer } from "../../src/features/project-storage/fakeServer.ts"
import { fakeSupabase, person, signedIn, type FakeSupabase } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

// The comments panel beside the open file: its toggle and shortcut, whole
// note comments, replies, resolving and reopening, edits and deletes by
// role, a viewer's and an offline reader's panel, comments arriving from
// elsewhere, authors' names and agents, and the phone's sheet.

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
async function openNote(
  page: Page,
  { role, comments = [], name, content = NOTE }: { role?: "viewer" | "commenter"; comments?: string[]; name?: string; content?: string } = {},
): Promise<Opened> {
  const server = new FakeProjectServer()
  server.emails.set(SOMEONE_ELSE, "ada@example.com")
  if (name) server.names.set(SOMEONE_ELSE, name)
  const owner = server.remote(role ? SOMEONE_ELSE : person.id)
  const id = crypto.randomUUID()
  await owner.createProject(id, "Plans")
  await owner.saveFiles(id, crypto.randomUUID(), [{ op: "put", path: "notes/plan.md", content }])
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

/** A whole note comment from someone else, written as another device would, or by their agent. */
function commentAsSomeoneElse(fake: FakeSupabase, id: string, body: string, { agent = false } = {}) {
  const file = fake.server.projects.get(id)!.files.get("notes/plan.md")!
  fake.comments.call(
    SOMEONE_ELSE,
    "add_comment",
    { project_id: id, thread_id: crypto.randomUUID(), file_id: file.id, file_version: file.version, anchor: { kind: "document" }, body },
    { agent },
  )
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
  // Sent, the reply field closes and Reply has the keyboard again.
  await expect(whole.getByRole("textbox", { name: "Reply" })).toHaveCount(0)
  await expect(whole.getByRole("button", { name: "Reply" })).toBeFocused()
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
  // The keyboard follows the thread back to Open.
  await expect(whole).toBeFocused()
  expect(fake.comments.threads.length).toBe(1)

  // Delete asks first: Cancel keeps the comment.
  await whole.getByRole("button", { name: `Actions for the comment by ${person.email}` }).last().click()
  await page.getByRole("menuitem", { name: "Delete" }).click()
  const confirm = page.getByRole("alertdialog", { name: "Delete this comment?" })
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused()
  await confirm.getByRole("button", { name: "Cancel" }).click()
  await expect(confirm).toBeHidden()
  await expect(whole.getByText("Yes, until Monday.")).toBeVisible()

  // Deleting the reply leaves the thread; deleting the last comment takes it.
  await whole.getByRole("button", { name: `Actions for the comment by ${person.email}` }).last().click()
  await page.getByRole("menuitem", { name: "Delete" }).click()
  await confirm.getByRole("button", { name: "Delete" }).click()
  await expect(whole.getByText("Yes, until Monday.")).toBeHidden()
  await expect(whole.getByText("Comment deleted")).toBeVisible()
  await whole.getByRole("button", { name: `Actions for the comment by ${person.email}` }).click()
  await page.getByRole("menuitem", { name: "Delete" }).click()
  await confirm.getByRole("button", { name: "Delete" }).click()
  await expect(whole).toBeHidden()
  await expect(panel(page).getByText("No comments yet")).toBeVisible()
  expect(fake.comments.threads.length).toBe(0)
})

test("an empty reply field closes when a comment in its thread is deleted; one with words stays", async ({ page }) => {
  const { fake, id } = await openNote(page)
  await toggle(page).click()
  await panel(page).getByRole("button", { name: "Comment on the whole note" }).first().click()
  await panel(page).getByRole("textbox", { name: "New comment" }).fill("Is the plan still current?")
  await panel(page).getByRole("textbox", { name: "New comment" }).press("ControlOrMeta+Enter")
  const whole = thread(page, "Comments on Whole note")
  const threadId = fake.comments.threads[0].id
  for (const body of ["Yes.", "Until Friday."]) fake.comments.call(person.id, "reply_comment", { thread_id: threadId, comment_id: crypto.randomUUID(), body })
  fake.signal(id, fake.server.projects.get(id)!.revision)
  await expect(whole.getByText("Until Friday.")).toBeVisible()
  const confirm = page.getByRole("alertdialog", { name: "Delete this comment?" })
  const actions = whole.getByRole("button", { name: `Actions for the comment by ${person.email}` })

  // Reply opened and left empty: deleting the last reply closes it, and Reply has the keyboard.
  await whole.getByRole("button", { name: "Reply" }).click()
  await expect(whole.getByRole("textbox", { name: "Reply" })).toBeFocused()
  await actions.last().click()
  await page.getByRole("menuitem", { name: "Delete" }).click()
  await confirm.getByRole("button", { name: "Delete" }).click()
  await expect(whole.getByText("Until Friday.")).toBeHidden()
  await expect(whole.getByRole("textbox", { name: "Reply" })).toHaveCount(0)
  await expect(whole.getByRole("button", { name: "Reply" })).toBeFocused()

  // With words in it, it stays open and keeps them.
  await whole.getByRole("button", { name: "Reply" }).click()
  await whole.getByRole("textbox", { name: "Reply" }).fill("Half a thought")
  await actions.nth(1).click()
  await page.getByRole("menuitem", { name: "Delete" }).click()
  await confirm.getByRole("button", { name: "Delete" }).click()
  await expect(whole.getByText("Yes.", { exact: true })).toBeHidden()
  await expect(whole.getByRole("textbox", { name: "Reply" })).toHaveValue("Half a thought")
})

test("comments show their authors' names, else their emails, and a person sets their own name in Settings", async ({ page }) => {
  const { fake } = await openNote(page, { comments: ["Please add dates."], name: "Ada Lovelace" })
  await toggle(page).click()
  const theirs = thread(page, "Comments on Whole note").filter({ hasText: "Please add dates." })
  await expect(theirs.getByText("Ada Lovelace", { exact: true })).toBeVisible()
  await expect(theirs.getByText("ada@example.com")).toHaveCount(0)
  await expect(theirs.getByRole("button", { name: "Actions for the comment by Ada Lovelace" })).toBeVisible()

  // The person has no name yet: their comment shows their email.
  await panel(page).getByRole("button", { name: "Comment on the whole note" }).first().click()
  await panel(page).getByRole("textbox", { name: "New comment" }).fill("Dates by Friday.")
  await panel(page).getByRole("textbox", { name: "New comment" }).press("ControlOrMeta+Enter")
  const mine = thread(page, "Comments on Whole note").filter({ hasText: "Dates by Friday." })
  await expect(mine.getByText(person.email, { exact: true })).toBeVisible()
  // The account panel names them the same way, once, with no name made up from the email.
  const row = page.locator('[data-slot="person-row"]')
  await expect(row.getByText(person.email, { exact: true })).toHaveCount(1)
  await expect(row.getByText("Person", { exact: true })).toHaveCount(0)

  // Settings > Account: Your name.
  await page.getByRole("button", { name: "Look and theme" }).click()
  const settings = page.getByRole("dialog", { name: "Settings" })
  const field = settings.getByRole("textbox", { name: "Your name" })
  await expect(field).toHaveValue("")
  await expect(settings.getByRole("button", { name: "Save" })).toBeDisabled()
  await field.fill("  Pat   Person ")
  await settings.getByRole("button", { name: "Save" }).click()
  await expect(settings.getByRole("status").filter({ hasText: "Name saved." })).toBeVisible()
  await expect(field).toHaveValue("Pat Person")
  const saved = fake.requests.find((request) => request.method() === "PUT" && request.url().endsWith("/auth/v1/user"))
  expect(saved?.postDataJSON()).toMatchObject({ data: { display_name: "Pat Person" } })
  await page.keyboard.press("Escape")
  // The comments open now name them, as the account panel does.
  await expect(mine.getByText("Pat Person", { exact: true })).toBeVisible()
  await expect(row.getByText("Pat Person", { exact: true })).toBeVisible()

  // Comments name them from then on, here and on other devices.
  await page.reload()
  await toggle(page).click()
  await expect(thread(page, "Comments on Whole note").filter({ hasText: "Dates by Friday." }).getByText("Pat Person", { exact: true })).toBeVisible()
})

test("a comment an agent wrote says so, the person's own agent's included, and is read out as new", async ({ page }) => {
  const { fake, id } = await openNote(page, { comments: ["Please add dates."] })
  await toggle(page).click()
  const whole = thread(page, "Comments on Whole note").filter({ hasText: "Please add dates." })
  await expect(whole).toBeVisible()
  await expect(panel(page).getByText("via agent")).toHaveCount(0)

  // The person's agent replies, and someone else's agent starts a thread.
  const threadId = fake.comments.threads[0].id
  fake.comments.call(person.id, "reply_comment", { thread_id: threadId, comment_id: crypto.randomUUID(), body: "Dates added for each step." }, { agent: true })
  commentAsSomeoneElse(fake, id, "Written by their agent too.", { agent: true })
  fake.signal(id, fake.server.projects.get(id)!.revision)
  const reply = whole.locator('[data-slot="comment"]').filter({ hasText: "Dates added for each step." })
  await expect(reply.getByText("via agent")).toBeVisible()
  await expect(reply.getByText("via agent")).toHaveAttribute("title", "Written by their agent")
  const other = panel(page).locator('[data-slot="comment"]').filter({ hasText: "Written by their agent too." })
  await expect(other.getByText("via agent")).toBeVisible()
  // Only the agents' comments say so.
  await expect(panel(page).getByText("via agent")).toHaveCount(2)
  await expect(whole.locator('[data-slot="comment"]').filter({ hasText: "Please add dates." }).getByText("via agent")).toHaveCount(0)
  // Written through their agent, the person's own reply is new to them.
  await expect(announced(page)).toHaveText("2 new comments")
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
  // Escape in the panel closes it too, as it closes the phone's sheet.
  await page.keyboard.press("ControlOrMeta+Alt+m")
  await expect(panel(page)).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(panel(page)).toBeHidden()
  await expect(toggle(page)).toBeFocused()
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
  await page.getByRole("alertdialog", { name: "Delete this comment?" }).getByRole("button", { name: "Delete" }).click()
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
    // Polled: while the sheet is still settling, its scale can make a button a hair short of 40.
    const height = async (name: string) => (await sheet.getByRole("button", { name }).boundingBox())?.height ?? 0
    await expect.poll(() => height("Reply")).toBeGreaterThanOrEqual(40)
    await expect.poll(() => height("Go to Whole note")).toBeGreaterThanOrEqual(40)
    const tall = (await sheet.boundingBox())!.height
    expect(tall).toBeCloseTo(844 * 0.75, -1)
    // While a new comment is written the sheet is half the screen, so the note shows above it.
    await sheet.getByRole("button", { name: "Comment on the whole note" }).first().click()
    await expect(sheet.getByRole("textbox", { name: "New comment" })).toBeFocused()
    await expect.poll(async () => Math.round((await sheet.boundingBox())!.height)).toBe(422)
    await sheet.getByRole("button", { name: "Cancel" }).click()
    await expect.poll(async () => Math.round((await sheet.boundingBox())!.height)).toBe(633)
    await page.keyboard.press("Escape")
    await expect(sheet).toBeHidden()
  })

  test("a new comment's text, low on the screen, moves up above the sheet", async ({ page }) => {
    const lines = Array.from({ length: 40 }, (_, index) => `Step ${index + 1} of the plan.`)
    await openNote(page, { content: `# Plan\n\n${lines.join("\n\n")}\n` })
    const frame = page.frameLocator('iframe[title="Isolated document preview"]')
    await expect(frame.getByText("Step 1 of the plan.", { exact: true })).toBeVisible({ timeout: 15_000 })
    // A step in the bottom part of the screen, where the sheet will be.
    let target = ""
    for (const line of lines) {
      const box = await frame.getByText(line, { exact: true }).boundingBox()
      if (box && box.y > 844 * 0.6 && box.y + box.height < 800) {
        target = line
        break
      }
    }
    expect(target).not.toBe("")
    await frame.getByText(target, { exact: true }).click({ clickCount: 3 })
    await page.getByRole("button", { name: "Comment", exact: true }).click()
    const sheet = page.getByRole("dialog", { name: "Comments" })
    await expect(sheet.getByRole("textbox", { name: "New comment" })).toBeFocused()
    await expect.poll(async () => Math.round((await sheet.boundingBox())!.height)).toBe(422)
    // The text being commented on shows between the file's controls and the sheet.
    const marked = frame.locator(".comment-highlight")
    await expect(marked).toHaveText([target])
    await expect
      .poll(async () => {
        const box = (await marked.boundingBox())!
        const top = (await sheet.boundingBox())!.y
        return box.y >= 64 && box.y + box.height <= top
      })
      .toBe(true)
    await expect(sheet.getByRole("textbox", { name: "New comment" })).toBeFocused()
  })
})
