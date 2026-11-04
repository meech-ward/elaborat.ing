import AxeBuilder from "./axe.ts"
import { expect, test, type Page } from "./fixtures.ts"
import { FakeProjectServer } from "../../src/features/project-storage/fakeServer.ts"
import { fakeSupabase, person, signedIn } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

test.describe.configure({ timeout: 60_000 })

const OTHER = "5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f"
const PATH = "plan.md"
const NOTE = "# Plan\n\nA file to share.\n"
const projectUrl = (id: string, path = PATH) => new URL(`projects/${id}/${path}`, APP_URL).href
const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST, OPTIONS" }
type LinkRow = { id: string; file_id: string; path: string; token: string; created_at: string; revoked_at: string | null }

/** Intercept only the new owner RPCs; normal project sync uses the shared fake. */
async function ownerFixture(page: Page, options: { role?: "owner" | "editor" | "commenter" | "viewer"; archived?: boolean } = {}) {
  const role = options.role ?? "owner"
  const server = new FakeProjectServer()
  const owner = role === "owner" ? person.id : OTHER
  const remote = server.remote(owner)
  const id = crypto.randomUUID()
  await remote.createProject(id, "Sharing check")
  await remote.saveFiles(id, crypto.randomUUID(), [{ op: "put", path: PATH, content: NOTE }])
  const fileId = server.projects.get(id)!.files.get(PATH)!.id
  if (role !== "owner") server.share(id, person.id, role)
  if (options.archived) await remote.archiveProject(id)
  await fakeSupabase(page, { server })
  const sharing = { row: null as LinkRow | null, rotations: 0, readFailure: false, writeFailure: false, calls: [] as Array<{ name: string; args: Record<string, unknown> }> }
  await page.route(/\/rest\/v1\/rpc\/(?:get|set)_file_share$/, async route => {
    const request = route.request()
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers })
    const name = new URL(request.url()).pathname.split("/").at(-1)!
    const args = request.postDataJSON() as Record<string, unknown>
    sharing.calls.push({ name, args })
    if (args.project_id !== id || args.file_id !== fileId) return route.fulfill({ status: 403, headers, json: { code: "42501", message: "File unavailable" } })
    if (name === "get_file_share" && sharing.readFailure) return route.fulfill({ status: 503, headers, json: { code: "", message: "Sharing is temporarily unavailable." } })
    if (name === "set_file_share") {
      if (sharing.writeFailure) return route.fulfill({ status: 403, headers, json: { code: "42501", message: "File sharing was refused." } })
      if (args.enabled) {
        if (!sharing.row || sharing.row.revoked_at || args.replace_link) {
          const token = String.fromCharCode(97 + sharing.rotations++).repeat(64)
          sharing.row = { id: sharing.row?.id ?? crypto.randomUUID(), file_id: fileId, path: PATH, token, created_at: "2026-11-03T10:00:00Z", revoked_at: null }
        }
      } else if (sharing.row) sharing.row.revoked_at = "2026-11-03T11:00:00Z"
    }
    const file = [...server.projects.get(id)!.files.values()].find(candidate => candidate.id === fileId)
    if (sharing.row && file) sharing.row.path = file.path
    return route.fulfill({ headers, json: sharing.row })
  })
  await page.addInitScript(() => {
    if (window !== window.top) return
    const writes: string[] = []
    Object.defineProperty(window, "__sharedFileCopies", { value: writes })
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { writes.push(value) } } })
  })
  await signedIn(page)
  await page.goto(projectUrl(id))
  if ((page.viewportSize()?.width ?? 1280) < 600) await expect(page.getByRole("button", { name: "Back to files and projects" })).toBeVisible({ timeout: 15_000 })
  else if (options.archived) await expect(page.getByRole("button", { name: "Unarchive", exact: true })).toBeVisible({ timeout: 15_000 })
  else await expect(page.getByRole("status").filter({ hasText: "Synced" })).toBeVisible({ timeout: 15_000 })
  return { server, remote, id, fileId, sharing }
}

async function openSharing(page: Page, phone = false, path = PATH) {
  if (phone) {
    if (!(await page.getByRole("region", { name: "Files and projects", exact: true }).isVisible())) await page.getByRole("button", { name: "Back to files and projects" }).click()
    const files = page.getByRole("navigation", { name: "Workspace files" }).first()
    await files.getByRole("button", { name: `Actions for ${path}`, exact: true }).click()
    await page.getByRole("menuitem", { name: "Share file", exact: true }).click()
  } else await page.getByRole("button", { name: "Share file", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Share file", exact: true })
  await expect(dialog).toBeVisible()
  return dialog
}

for (const width of [1280, 390]) {
  test.describe(`owner sharing at ${width}px`, () => {
    const phone = width < 600
    test.use({ viewport: { width, height: 900 }, hasTouch: phone })

    test("enables, copies, restores, replaces and disables one file link", async ({ page }) => {
      const fixture = await ownerFixture(page)
      const dialog = await openSharing(page, phone)
      await expect(dialog.getByText("Link sharing is off.", { exact: true })).toBeVisible()
      await expect(dialog).toContainText("underlying source")
      await expect(dialog).toContainText("separate from private project comments")
      await dialog.getByRole("button", { name: "Enable link", exact: true }).click()
      const input = dialog.getByRole("textbox", { name: "Unlisted file link" })
      const first = new URL(`/s/${"a".repeat(64)}`, APP_URL).href
      await expect(input).toHaveValue(first)
      await expect(dialog.getByRole("link", { name: "Open link" })).toHaveAttribute("href", first)
      await dialog.getByRole("button", { name: "Copy link", exact: true }).click()
      await expect(dialog.getByText("Link copied.", { exact: true })).toBeVisible()
      expect(await page.evaluate(() => (window as unknown as { __sharedFileCopies: string[] }).__sharedFileCopies)).toEqual([first])
      const axe = await new AxeBuilder({ page }).include('[role="dialog"]').analyze()
      expect(axe.violations.map(violation => ({ id: violation.id, nodes: violation.nodes.map(node => node.target) }))).toEqual([])
      const box = await dialog.boundingBox()
      expect(box && box.x >= 0 && box.x + box.width <= width).toBe(true)
      await dialog.getByRole("button", { name: "Close", exact: true }).click()
      await expect(dialog).toBeHidden()
      await openSharing(page, phone)
      await expect(input).toHaveValue(first)
      page.once("dialog", prompt => prompt.accept())
      await dialog.getByRole("button", { name: "Replace link", exact: true }).click()
      await expect(input).toHaveValue(new URL(`/s/${"b".repeat(64)}`, APP_URL).href)
      await dialog.getByRole("button", { name: "Disable link", exact: true }).click()
      await expect(dialog.getByText("Link sharing is off.", { exact: true })).toBeVisible()
      await expect(input).toHaveCount(0)
      expect(fixture.sharing.row?.revoked_at).not.toBeNull()
      expect(fixture.sharing.calls.filter(call => call.name === "set_file_share").map(call => call.args)).toEqual([
        { project_id: fixture.id, file_id: fixture.fileId, enabled: true, replace_link: false },
        { project_id: fixture.id, file_id: fixture.fileId, enabled: true, replace_link: true },
        { project_id: fixture.id, file_id: fixture.fileId, enabled: false, replace_link: false },
      ])
      expect(fixture.server.projects.get(fixture.id)!.members.size).toBe(0)
      expect(fixture.server.content(fixture.id, PATH)).toBe(NOTE)
    })
  })
}

for (const role of ["editor", "commenter", "viewer"] as const) {
  test(`${role} has no file-link controls`, async ({ page }) => {
    const { sharing } = await ownerFixture(page, { role })
    await expect(page.getByRole("button", { name: "Share file", exact: true })).toHaveCount(0)
    const files = page.getByRole("navigation", { name: "Workspace files" }).first()
    await files.getByRole("button", { name: `Actions for ${PATH}`, exact: true }).click()
    await expect(page.getByRole("menuitem", { name: "Copy filename", exact: true })).toBeVisible()
    await expect(page.getByRole("menuitem", { name: "Share file", exact: true })).toHaveCount(0)
    expect(sharing.calls).toEqual([])
  })
}

test("unsaved edits refuse sharing until they are saved and synchronized", async ({ page }) => {
  const { sharing, server, id } = await ownerFixture(page)
  await page.getByRole("button", { name: "Source", exact: true }).click()
  await page.locator(".monaco-editor:visible .view-lines").first().click()
  await page.keyboard.press("ControlOrMeta+End")
  await page.keyboard.type("More text.")
  await page.getByRole("button", { name: "Share file", exact: true }).click()
  await expect(page.getByText("Save or discard this file's unsaved changes before sharing it.", { exact: true })).toBeVisible()
  await expect(page.getByRole("dialog", { name: "Share file", exact: true })).toHaveCount(0)
  expect(sharing.calls).toEqual([])
  await page.locator(".monaco-editor:visible .view-lines").first().click()
  await page.keyboard.press("ControlOrMeta+s")
  await expect.poll(() => server.content(id, PATH)).toContain("More text.")
  await expect(page.getByRole("status").filter({ hasText: "Synced" })).toBeVisible()
  const dialog = await openSharing(page)
  await expect(dialog.getByRole("button", { name: "Enable link", exact: true })).toBeEnabled()
})

test("a read failure retries and a refused change remains visibly off", async ({ page, appErrors }) => {
  const { sharing } = await ownerFixture(page)
  sharing.readFailure = true
  appErrors.expect("Sharing is temporarily unavailable.")
  const dialog = await openSharing(page)
  await expect(dialog.getByRole("alert")).toHaveText("Sharing is temporarily unavailable.")
  sharing.readFailure = false
  await dialog.getByRole("button", { name: "Try again", exact: true }).click()
  await expect(dialog.getByRole("button", { name: "Enable link", exact: true })).toBeVisible()
  sharing.writeFailure = true
  appErrors.expect("File sharing was refused.")
  await dialog.getByRole("button", { name: "Enable link", exact: true }).click()
  await expect(dialog.getByRole("alert")).toHaveText("File sharing was refused.")
  await expect(dialog.getByText("Link sharing is off.", { exact: true })).toBeVisible()
  expect(sharing.row).toBeNull()
})

test("an archived project's owner can still enable and disable its file link", async ({ page }) => {
  const { sharing } = await ownerFixture(page, { archived: true })
  await expect(page.getByRole("banner").getByRole("status").filter({hasText: "This project is archived. Unarchive it to make changes."})).toBeVisible()
  const dialog = await openSharing(page)
  await dialog.getByRole("button", { name: "Enable link", exact: true }).click()
  await expect(dialog.getByText("Link sharing is on.", { exact: true })).toBeVisible()
  await dialog.getByRole("button", { name: "Disable link", exact: true }).click()
  await expect(dialog.getByText("Link sharing is off.", { exact: true })).toBeVisible()
  expect(sharing.row?.revoked_at).not.toBeNull()
})
