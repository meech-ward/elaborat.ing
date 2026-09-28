import { readFileSync } from "node:fs"
import { expect, test, type Page } from "@playwright/test"
import { unzipSync } from "fflate"
import { FakeProjectServer } from "../../src/features/project-storage/fakeServer.ts"
import { fakeSupabase, person, signedIn } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

// When its owner deletes a project someone is in, they are told so, on the
// project and on their projects home, instead of seeing it stop syncing. The
// project leaves their list and this device; unsaved changes to it are
// offered as a .zip first.

test.describe.configure({ timeout: 60_000 })

const OWNER = "5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f"
const DELETED = "This project was deleted by its owner."

/** A project OWNER owns, with a note, shared with the person as an editor. */
async function theirProject(server: FakeProjectServer) {
  const id = crypto.randomUUID()
  await server.remote(OWNER).createProject(id, "Their notes")
  await server.remote(OWNER).saveFiles(id, crypto.randomUUID(), [{ op: "put", path: "notes/a.md", content: "# A\n" }])
  server.share(id, person.id, "editor")
  return id
}

/** The page checks for changes when the window gets focus, as it does every minute. */
const refocus = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event("focus")))

test("with the project open, the person is told its owner deleted it, and it leaves their list and this device", async ({ page }) => {
  const server = new FakeProjectServer()
  const id = await theirProject(server)
  await fakeSupabase(page, { server })
  await signedIn(page)
  await page.goto(new URL(`projects/${id}/notes/a.md`, APP_URL).href)
  await expect(page.getByRole("status").filter({ hasText: "Synced" })).toBeVisible({ timeout: 15_000 })

  await server.remote(OWNER).deleteProject(id)
  await refocus(page)
  await expect(page.getByRole("heading", { name: "Their notes" })).toBeVisible()
  await expect(page.getByRole("status").filter({ hasText: DELETED })).toContainText("It is no longer on this device.")
  await expect(page.getByText("Not synced")).toHaveCount(0)

  await page.getByRole("link", { name: "Back to your projects" }).click()
  await expect(page.getByRole("heading", { name: "Your projects" })).toBeVisible()
  await expect(page.getByRole("status").filter({ hasText: "Their notes was deleted by its owner." })).toBeVisible()
  await expect(page.getByRole("link", { name: "Their notes" })).toHaveCount(0)
  await page.getByRole("button", { name: "Dismiss" }).click()
  await expect(page.getByText("Their notes was deleted by its owner.")).toHaveCount(0)

  // Gone from this device too: nothing of it comes back after a reload.
  await page.reload()
  await expect(page.getByText("No projects yet.")).toBeVisible()
  await expect(page.getByText("Their notes")).toHaveCount(0)
})

test("on the projects home, the person is told, and unsaved changes are offered as a .zip before the project is removed", async ({ page }) => {
  const server = new FakeProjectServer()
  const id = await theirProject(server)
  await fakeSupabase(page, { server })
  await signedIn(page)
  // Leaving with an unsaved edit, and removing it, each ask first.
  page.on("dialog", (dialog) => void dialog.accept().catch(() => {}))
  await page.goto(new URL(`projects/${id}/notes/a.md`, APP_URL).href)
  await expect(page.getByRole("status").filter({ hasText: "Synced" })).toBeVisible({ timeout: 15_000 })
  await page.locator(".monaco-editor:visible .view-lines").first().click()
  await page.keyboard.press("ControlOrMeta+End")
  await page.keyboard.type("Not saved.")
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeVisible()
  // The edit is kept on this device as an unsaved draft before the person goes home.
  await page.waitForTimeout(300)
  await page.goto(APP_URL)
  await expect(page.getByRole("link", { name: "Their notes" })).toBeVisible()

  await server.remote(OWNER).deleteProject(id)
  await refocus(page)
  const banner = page.getByRole("status").filter({ hasText: "Their notes was deleted by its owner." })
  await expect(banner).toContainText("Your unsaved changes to 1 file are still on this device.")
  await expect(page.getByRole("link", { name: "Their notes" })).toHaveCount(0)

  const downloading = page.waitForEvent("download")
  await banner.getByRole("button", { name: "Download unsaved changes" }).click()
  const download = await downloading
  expect(download.suggestedFilename()).toBe("Their notes unsaved changes.zip")
  const entries = unzipSync(new Uint8Array(readFileSync((await download.path())!)))
  expect(Object.keys(entries)).toEqual(["notes/a.md"])
  expect(new TextDecoder().decode(entries["notes/a.md"])).toBe("# A\nNot saved.")

  await banner.getByRole("button", { name: "Remove from this device" }).click()
  await expect(page.getByText("Their notes was deleted by its owner.")).toHaveCount(0)
  await page.reload()
  await expect(page.getByText("No projects yet.")).toBeVisible()
})

test("with unsaved changes on the open project, the page offers them and removes the project when asked", async ({ page }) => {
  const server = new FakeProjectServer()
  const id = await theirProject(server)
  await fakeSupabase(page, { server })
  await signedIn(page)
  page.on("dialog", (dialog) => void dialog.accept().catch(() => {}))
  await page.goto(new URL(`projects/${id}/notes/a.md`, APP_URL).href)
  await expect(page.getByRole("status").filter({ hasText: "Synced" })).toBeVisible({ timeout: 15_000 })
  await page.locator(".monaco-editor:visible .view-lines").first().click()
  await page.keyboard.press("ControlOrMeta+End")
  await page.keyboard.type("Not saved.")
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeVisible()
  await page.waitForTimeout(300)

  await server.remote(OWNER).deleteProject(id)
  await refocus(page)
  await expect(page.getByRole("status").filter({ hasText: DELETED })).toContainText("Your unsaved changes to 1 file are still on this device.")
  const downloading = page.waitForEvent("download")
  await page.getByRole("button", { name: "Download unsaved changes" }).click()
  expect((await downloading).suggestedFilename()).toBe("Their notes unsaved changes.zip")

  await page.getByRole("button", { name: "Remove from this device" }).click()
  await expect(page.getByRole("heading", { name: "Your projects" })).toBeVisible()
  await expect(page.getByText("No projects yet.")).toBeVisible()
  await expect(page.getByText("Their notes")).toHaveCount(0)
})
