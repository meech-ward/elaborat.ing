import { expect, test, type Page } from "@playwright/test"
import { sectionAnchor, textAnchor } from "../../src/features/comments/placement.ts"
import { fakeSupabase, person, signedIn, type FakeSupabase } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

// Comments in a note: commented text is marked in Source (a highlight, and a
// marker beside its line) and in Rendered (a highlight), each placed in the
// text on screen as it changes. A thread whose text is deleted is no longer
// marked.

test.describe.configure({ timeout: 60_000 })

const PATH = "docs/customer-model.md"
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

/** A project with the note and two threads on it: one on "where agents help", one on the Steps section. */
async function seeded(page: Page): Promise<{ fake: FakeSupabase; id: string }> {
  const fake = await fakeSupabase(page)
  const remote = fake.server.remote(person.id)
  const id = crypto.randomUUID()
  await remote.createProject(id, "Product notes")
  await remote.saveFiles(id, crypto.randomUUID(), [{ op: "put", path: PATH, content: NOTE }])
  const fileId = [...fake.server.projects.get(id)!.files.values()].find((file) => file.path === PATH)!.id
  const quote = NOTE.indexOf("where agents help")
  for (const [anchor, body] of [
    [textAnchor(NOTE, quote, quote + "where agents help".length), "Which agents?"],
    [sectionAnchor(NOTE, NOTE.indexOf("## Steps")), "Add a step for inviting a teammate."],
  ] as const) {
    fake.comments.call(person.id, "add_comment", { project_id: id, thread_id: crypto.randomUUID(), file_id: fileId, file_version: 1, anchor, body })
  }
  await signedIn(page)
  await page.goto(new URL(`projects/${id}/${PATH}`, APP_URL).href)
  await expect(page.getByRole("tabpanel", { name: PATH })).toBeVisible({ timeout: 15_000 })
  await page.getByRole("button", { name: "Split", exact: true }).click()
  await expect(frameOf(page).getByRole("heading", { name: "Customer model" })).toBeVisible({ timeout: 15_000 })
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
