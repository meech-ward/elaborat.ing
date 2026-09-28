import AxeBuilder from "./axe.ts"
import { expect, test, type Page } from "@playwright/test"
import { fakeSupabase, person, signedIn, type FakeSupabase } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

// Settings > Account > Delete account: what deleting does, first; the
// person's email typed to confirm; then the account goes, this device
// forgets its projects and drafts, and the page signs out.

test.describe.configure({ timeout: 60_000 })

const BOB = "7c1d2e3f-4a5b-4c6d-8e7f-8091a2b3c4d5"
const NOTE = "# Plan\n\nShared line\n"
const projectUrl = (id: string, file?: string) => new URL(`projects/${id}${file ? `/${file}` : ""}`, APP_URL).href

/** The person owns Team notes (Bob has accepted it) and Solo; Bob's plans is Bob's, shared with the person. */
async function setUp(page: Page) {
  const fake = await fakeSupabase(page)
  fake.server.emails.set(BOB, "bob@example.com")
  const mine = fake.server.remote(person.id)
  const bobs = fake.server.remote(BOB)
  const team = crypto.randomUUID()
  const solo = crypto.randomUUID()
  const theirs = crypto.randomUUID()
  await mine.createProject(team, "Team notes")
  await mine.saveFiles(team, crypto.randomUUID(), [{ op: "put", path: "a.md", content: NOTE }])
  await mine.shareProject(team, BOB, "editor")
  await bobs.acceptInvitation(team)
  await mine.createProject(solo, "Solo")
  await bobs.createProject(theirs, "Bob's plans")
  await bobs.shareProject(theirs, person.id, "commenter")
  await mine.acceptInvitation(theirs)
  await signedIn(page)
  await page.goto(projectUrl(team, "a.md"))
  await expect(page.getByRole("status").filter({ hasText: "Synced" })).toBeVisible({ timeout: 15_000 })
  return { fake, team, solo, theirs }
}

/** Settings > Account > Delete account..., with the person's email typed. */
async function startDeleting(page: Page) {
  await page.getByRole("button", { name: "Look and theme" }).click()
  await page.getByRole("dialog", { name: "Settings" }).getByRole("button", { name: "Delete account..." }).click()
  const dialog = page.getByRole("alertdialog", { name: "Delete your account?" })
  await expect(dialog.getByRole("list", { name: "Projects you own" })).toBeVisible()
  return dialog
}

/** The partitions of the projects this browser keeps in IndexedDB. */
const storedPartitions = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<string[]>((resolve, reject) => {
        const open = indexedDB.open("elaborating")
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const all = open.result.transaction("projects").objectStore("projects").getAll()
          all.onerror = () => reject(all.error)
          all.onsuccess = () => {
            open.result.close()
            resolve((all.result as Array<{ partition: string }>).map((row) => row.partition))
          }
        }
      }),
  )

const deleteRequests = (fake: FakeSupabase) => fake.requests.filter((request) => new URL(request.url()).pathname === "/functions/v1/delete-account")

test("a person sees what deleting does, confirms with their email, and the account and this device's copies are gone", async ({ page }) => {
  const { fake, team, theirs } = await setUp(page)
  expect((await storedPartitions(page)).some((partition) => partition.includes(person.id))).toBe(true)

  const dialog = await startDeleting(page)
  const owned = dialog.getByRole("list", { name: "Projects you own" }).getByRole("listitem")
  await expect(owned).toHaveText(["SoloOnly you", "Team notesShared with 1 person"])
  await expect(dialog).toContainText("The 2 projects you own are deleted, for everyone they are shared with. You cannot hand a project to someone else yet. To keep a copy, choose Download project in its menu first.")
  await expect(dialog).toContainText("You leave the project shared with you.")
  await expect(dialog).toContainText("Your comments stay where you wrote them, shown as from a deleted account.")
  await expect(dialog).toContainText("Agents you connected lose access.")
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeVisible()
  expect(await new AxeBuilder({ page }).include('[role="alertdialog"]').analyze().then((result) => result.violations)).toEqual([])

  const remove = dialog.getByRole("button", { name: "Delete account" })
  const email = dialog.getByLabel(`Type ${person.email} to confirm`)
  await expect(remove).toBeDisabled()
  await email.fill("someone@example.com")
  await expect(remove).toBeDisabled()
  await email.fill(" Person@Example.com ")
  await remove.click()

  await expect(page.getByRole("dialog", { name: "Settings" }).getByText("Your account was deleted, and you are signed out.")).toBeVisible()
  expect(fake.accountDeleted).toBe(true)
  expect(deleteRequests(fake).map((request) => request.postDataJSON())).toEqual([{ email: " Person@Example.com " }])
  expect(fake.server.projects.has(team)).toBe(false)
  expect(fake.server.projects.get(theirs)?.members.has(person.id)).toBe(false)
  expect((await storedPartitions(page)).some((partition) => partition.includes(person.id))).toBe(false)
  await expect.poll(() => page.evaluate(() => localStorage.getItem("elaborating.offline-account.v1"))).toBeNull()
})

test("when signing out would lose unreconciled work, nothing is deleted until the person deletes anyway", async ({ page }) => {
  const { fake, team } = await setUp(page)
  // Unsaved edits to a note that another device then changes: this device has to settle it first.
  await page.locator(".monaco-editor:visible .view-lines").first().click()
  await page.keyboard.press("ControlOrMeta+End")
  await page.keyboard.type("My line")
  const version = fake.server.projects.get(team)!.files.get("a.md")!.version
  const saved = await fake.server.remote(person.id).saveFiles(team, crypto.randomUUID(), [{ op: "put", path: "a.md", content: `${NOTE}Their line\n`, base_version: version }])
  fake.signal(team, saved.project.revision)
  await expect(page.getByRole("alert").filter({ hasText: "was changed elsewhere while you were editing" })).toBeVisible({ timeout: 15_000 })

  const dialog = await startDeleting(page)
  await dialog.getByLabel(`Type ${person.email} to confirm`).fill(person.email)
  await dialog.getByRole("button", { name: "Delete account" }).click()
  const kept = dialog.getByRole("status").filter({ hasText: "Nothing was deleted." })
  await expect(kept).toContainText("a.md")
  await expect(kept).toContainText("Or delete anyway, and lose any changes on this device.")
  expect(deleteRequests(fake)).toEqual([])
  expect(fake.accountDeleted).toBe(false)

  await kept.getByRole("button", { name: "Delete anyway" }).click()
  await expect(page.getByRole("dialog", { name: "Settings" }).getByText("Your account was deleted, and you are signed out.")).toBeVisible()
  expect(fake.accountDeleted).toBe(true)
  expect((await storedPartitions(page)).some((partition) => partition.includes(person.id))).toBe(false)
})
