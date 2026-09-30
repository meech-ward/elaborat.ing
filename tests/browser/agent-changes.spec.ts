import { expect, test, type Page } from "@playwright/test"
import AxeBuilder from "./axe.ts"
import { FakeProjectServer } from "../../src/features/project-storage/fakeServer.ts"
import { fakeSupabase, person, signedIn, type FakeSupabase } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

// Agent changes: the count of versions agents saved since the person last
// looked, on the project's button; the view with each change's diff, the
// thread it answered and Revert; and a comment's version link opening it.

test.describe.configure({ timeout: 60_000 })

const projectUrl = (id: string, path?: string) => new URL(`projects/${id}${path ? `/${path}` : ""}`, APP_URL).href
const BEFORE = "# Plan\n\nShip the comments panel first.\n"
const AFTER = "# Plan\n\nShip the comments panel first, by Friday.\n"

type Opened = { fake: FakeSupabase; id: string }

/**
 * The person's project with notes/plan.md, which their agent then changed
 * (version 2), opened at `path`; `seed` adds more before the page opens.
 */
async function openProject(page: Page, { path, seed }: { path?: string; seed?: (fake: FakeSupabase, id: string) => void } = {}): Promise<Opened> {
  const server = new FakeProjectServer()
  const id = crypto.randomUUID()
  const owner = server.remote(person.id)
  await owner.createProject(id, "Plans")
  await owner.saveFiles(id, crypto.randomUUID(), [{ op: "put", path: "notes/plan.md", content: BEFORE }])
  const fake = await fakeSupabase(page, { server })
  await fake.agentChanges.save(person.id, id, "notes/plan.md", AFTER)
  seed?.(fake, id)
  await signedIn(page)
  await page.goto(projectUrl(id, path))
  return { fake, id }
}

const view = (page: Page) => page.getByRole("dialog", { name: "Agent changes" })
const change = (page: Page) => view(page).getByRole("article", { name: "Claude for person@example.com: notes/plan.md changed" })

test("an agent's change shows with its diff and the thread it answered, is seen, and Revert saves the version before it", async ({ page }) => {
  const { fake, id } = await openProject(page, {
    seed: (fake) => {
      fake.agentChanges.changes[0].thread = { id: crypto.randomUUID(), comment_id: crypto.randomUUID(), opening: "Add a date" }
    },
  })

  await page.getByRole("button", { name: "Agent changes, 1 new" }).click()
  await expect(view(page)).toBeVisible()
  await expect(view(page).getByRole("heading", { name: /New since you last looked/ })).toBeVisible()
  await expect(change(page)).toBeVisible()
  await expect(change(page).getByText("New", { exact: true })).toBeVisible()
  await expect(change(page).getByText("changed, version 2")).toBeVisible()
  await expect(change(page).getByText("Answered “Add a date”")).toBeVisible()
  // The newest change starts unfolded: the version before it and this one, as a diff.
  await expect(change(page).locator(".editor.original")).toContainText("Ship the comments panel first.")
  await expect(change(page).locator(".editor.modified")).toContainText("Ship the comments panel first, by Friday.")
  await expect(change(page).getByText("Version 1", { exact: true })).toBeVisible()
  await expect(change(page).getByText("Version 2", { exact: true })).toBeVisible()
  const results = await new AxeBuilder({ page }).include('[role="dialog"]').analyze()
  expect(results.violations.map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => node.target) }))).toEqual([])

  // Opening the view marked it seen.
  await expect.poll(() => fake.agentChanges.seen.get(`${id}:${person.id}`)).toBe(2)

  await change(page).getByRole("button", { name: "Revert" }).click()
  await expect(change(page).getByRole("status")).toHaveText("Reverted: version 1's text is saved as a new version.")
  await expect(change(page).getByRole("button", { name: "Revert" })).toBeDisabled()
  // Through the normal save: the device's copy, synced with the version it was based on.
  await expect.poll(() => fake.server.content(id, "notes/plan.md")).toBe(BEFORE)
  const save = fake.requests.filter((request) => request.url().endsWith("/rpc/save_files")).at(-1)!
  expect(save.postDataJSON().changes).toEqual([{ op: "put", path: "notes/plan.md", content: BEFORE, base_version: 2 }])

  await page.keyboard.press("Escape")
  await expect(view(page)).toBeHidden()
  await expect(page.getByRole("button", { name: "Agent changes", exact: true })).toBeVisible()
})

test("Revert waits until this device has the agent's version, and stops once the file changed again", async ({ page }) => {
  const { fake, id } = await openProject(page)
  await expect(page.getByRole("status").filter({ hasText: "Synced" })).toBeVisible({ timeout: 15_000 })
  // The agent saves again, and this device has not heard yet.
  const LATER = "# Plan\n\nShip the comments panel first, by Thursday.\n"
  await fake.agentChanges.save(person.id, id, "notes/plan.md", LATER)

  await page.getByRole("button", { name: /^Agent changes/ }).click()
  const newest = view(page).getByRole("article").filter({ hasText: "changed, version 3" })
  await expect(newest.getByText("This device has not synced version 3 yet")).toBeVisible()
  await expect(newest.getByRole("button", { name: "Revert" })).toBeDisabled()
  await expect(change(page).filter({ hasText: "changed, version 2" }).getByText("Changed again since")).toBeVisible()

  // Once it syncs, Revert can run.
  fake.signal(id, fake.server.projects.get(id)!.revision)
  await expect(newest.getByRole("button", { name: "Revert" })).toBeEnabled()

  // Another device changes the file after the list loaded: once that syncs here, Revert stops.
  await fake.server.remote(person.id).saveFiles(id, crypto.randomUUID(), [{ op: "put", path: "notes/plan.md", content: BEFORE, base_version: 3 }])
  fake.signal(id, fake.server.projects.get(id)!.revision)
  await expect(newest.getByText("Changed again since")).toBeVisible()
  await expect(newest.getByRole("button", { name: "Revert" })).toBeDisabled()
  expect(fake.requests.filter((request) => request.url().endsWith("/rpc/save_files"))).toEqual([])
  expect(fake.server.content(id, "notes/plan.md")).toBe(BEFORE)
})

test("a comment's version link opens the change, and Open shows the file", async ({ page }) => {
  const { id } = await openProject(page, {
    path: "notes/plan.md",
    seed: (fake, id) => {
      const file = fake.server.projects.get(id)!.files.get("notes/plan.md")!
      const thread = crypto.randomUUID()
      fake.comments.call(person.id, "add_comment", {
        project_id: id, thread_id: thread, file_id: file.id, file_version: 1, anchor: { kind: "document" }, body: "Add a date",
      })
      fake.comments.call(person.id, "reply_comment", { thread_id: thread, comment_id: crypto.randomUUID(), body: "Done.", file_version: 2 }, { agent: true })
    },
  })

  await page.getByRole("button", { name: /^Comments(, \d+ open)?$/ }).click()
  await page.getByRole("complementary", { name: "Comments" }).getByRole("button", { name: "Changed in version 2" }).click()
  await expect(change(page)).toBeVisible()
  await expect(change(page)).toHaveAttribute("data-active", "true")
  await expect(change(page)).toBeFocused()

  await change(page).getByRole("button", { name: "Open" }).click()
  await expect(view(page)).toBeHidden()
  await expect(page).toHaveURL(projectUrl(id, "notes/plan.md"))
})

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test("the view is a sheet from the bottom, opened from the project's top line", async ({ page }) => {
    await openProject(page)
    // The project's only file opens; its files screen has the project's top line.
    await page.getByRole("button", { name: "Back to files and projects" }).click()
    await page.getByRole("button", { name: "Agent changes, 1 new" }).click()
    await expect(change(page)).toBeVisible()
    // From the bottom of the screen, below its top.
    await expect.poll(async () => {
      const box = await view(page).boundingBox()
      return box ? [box.y > 50, Math.round(box.y + box.height)] : null
    }).toEqual([true, 844])
    await view(page).getByRole("button", { name: "Close agent changes" }).click()
    await expect(view(page)).toBeHidden()
  })
})
