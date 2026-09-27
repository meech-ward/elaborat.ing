import { expect, test, type Page } from "@playwright/test"
import { fakeSupabase, person, signedIn } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

// Focus mode (desktop): only the file and its controls, and a way out.

test.describe.configure({ timeout: 60_000 })

async function openNote(page: Page) {
  const fake = await fakeSupabase(page)
  const id = crypto.randomUUID()
  const remote = fake.server.remote(person.id)
  await remote.createProject(id, "Notes")
  await remote.saveFiles(id, crypto.randomUUID(), [{ op: "put", path: "a.md", content: "# A\n" }])
  await signedIn(page)
  await page.goto(new URL(`projects/${id}/a.md`, APP_URL).href)
  await expect(page.getByRole("status").filter({ hasText: "Synced" })).toBeVisible({ timeout: 15_000 })
}

test("focus mode hides the side panels and tabs, and Exit full screen brings them back", async ({ page }) => {
  await openNote(page)
  const files = page.getByRole("navigation", { name: "Workspace files" })
  const tab = page.getByRole("tab", { name: "a.md" })
  await expect(files).toBeVisible()
  await page.keyboard.press("ControlOrMeta+Period")
  await expect(files).toHaveCount(0)
  await expect(tab).toBeHidden()
  await expect(page.getByRole("button", { name: "Source" })).toBeVisible()
  await page.getByRole("button", { name: "Exit full screen" }).click()
  await expect(files).toBeVisible()
  await expect(tab).toBeVisible()
  await page.getByRole("button", { name: "Focus" }).click()
  await expect(files).toHaveCount(0)
})
