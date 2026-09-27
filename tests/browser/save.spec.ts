import { expect, test } from "@playwright/test"
import { fakeSupabase, person, signedIn } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

// Save shows only while the open file has unsaved edits.

test.describe.configure({ timeout: 60_000 })

test("an edit shows Save and the tree row's dot, and saving hides them and writes the file", async ({ page }) => {
  const fake = await fakeSupabase(page)
  const id = crypto.randomUUID()
  const remote = fake.server.remote(person.id)
  await remote.createProject(id, "Notes")
  await remote.saveFiles(id, crypto.randomUUID(), [{ op: "put", path: "a.md", content: "# A\n" }])
  await signedIn(page)
  await page.goto(new URL(`projects/${id}/a.md`, APP_URL).href)
  await expect(page.getByRole("status").filter({ hasText: "Synced" })).toBeVisible({ timeout: 15_000 })
  const save = page.getByRole("button", { name: "Save", exact: true })
  const treeDot = page.getByRole("navigation", { name: "Workspace files" }).locator('[data-slot="dirty-dot"]')
  await expect(save).toHaveCount(0)
  await expect(treeDot).toHaveCount(0)
  await page.locator(".monaco-editor:visible .view-lines").first().click()
  await page.keyboard.press("ControlOrMeta+End")
  await page.keyboard.type("More.")
  await expect(save).toBeVisible()
  await expect(treeDot).toHaveCount(1)
  await save.click()
  await expect(save).toHaveCount(0)
  await expect(treeDot).toHaveCount(0)
  await expect.poll(() => fake.server.content(id, "a.md")).toContain("More.")
})
