import AxeBuilder from "@axe-core/playwright"
import { expect, test, type Page } from "@playwright/test"
import { FakeProjectServer } from "../../src/features/project-storage/fakeServer.ts"
import { fakeSupabase, person, quiet, signedIn } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

// Projects at their URLs, created, downloaded and synced against the
// stand-in Supabase, whose data is the unit tests' in-memory server.

const projectUrl = (id: string, path?: string) => new URL(`projects/${id}${path ? `/${path}` : ""}`, APP_URL).href

async function serverProject(server: FakeProjectServer, title: string, files: Record<string, string>) {
  const remote = server.remote(person.id)
  const id = crypto.randomUUID()
  await remote.createProject(id, title)
  for (const [path, content] of Object.entries(files)) {
    await remote.saveFiles(id, crypto.randomUUID(), [{ op: "put", path, content }])
  }
  return id
}

const addFile = async (server: FakeProjectServer, id: string, path: string, content: string) =>
  server.remote(person.id).saveFiles(id, crypto.randomUUID(), [{ op: "put", path, content }])

/** Show the explorer and expand the folders on the way to `path`. */
async function explorer(page: Page, path?: string) {
  const toggle = page.getByRole("button", { name: "Toggle explorer" })
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click()
  const parts = path?.split("/").slice(0, -1) ?? []
  for (let i = 1; i <= parts.length; i++) {
    const folder = parts.slice(0, i).join("/")
    const expand = page.getByRole("button", { name: `Expand ${folder}`, exact: true })
    if (await expand.count()) await expand.click()
  }
}

async function home(page: Page) {
  await page.goto(APP_URL)
  await expect(page.getByRole("heading", { name: "Your projects" })).toBeVisible()
}

test("a new project opens at its own URL and reaches the server", async ({ page }) => {
  const fake = await fakeSupabase(page)
  await signedIn(page)
  await home(page)
  await expect(page.getByText("No projects yet.")).toBeVisible()
  await page.getByLabel("New project").fill("Notes")
  await page.getByRole("button", { name: "Create" }).click()

  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/)
  const id = new URL(page.url()).pathname.split("/")[2]
  await expect(page.getByRole("heading", { level: 1, name: "Notes" })).toBeVisible()
  await expect(page.getByRole("status").filter({ hasText: "Synced" })).toBeVisible()
  expect(fake.server.projects.get(id)?.title).toBe("Notes")

  await page.getByRole("link", { name: "Your projects" }).click()
  await expect(page.getByRole("link", { name: "Notes" })).toBeVisible()
})

test("a project from the server downloads on open, and its files have URLs", async ({ page }) => {
  const server = new FakeProjectServer()
  const id = await serverProject(server, "Shared notes", { "readme.md": "# Hello", "notes/a b.md": "spaces in the name" })
  await fakeSupabase(page, { server })
  await signedIn(page)
  await home(page)
  const row = page.getByRole("listitem").filter({ hasText: "Shared notes" })
  await expect(row).toContainText("On the server")
  await row.getByRole("link").click()

  await expect(page).toHaveURL(projectUrl(id))
  await explorer(page, "notes/a b.md")
  await page.getByRole("button", { name: "notes/a b.md", exact: true }).click()
  await expect(page).toHaveURL(projectUrl(id, "notes/a%20b.md"))
  await expect(page.getByRole("tab", { name: "notes/a b.md" })).toBeVisible()
  await expect(page.getByText("spaces in the name")).toBeVisible()

  // The file's URL works on its own too.
  await page.goto(projectUrl(id, "readme.md"))
  await expect(page.getByRole("tab", { name: "readme.md" })).toBeVisible()
  await expect(page.getByText("# Hello")).toBeVisible()
})

test("a change made elsewhere arrives when the server signals it", async ({ page }) => {
  const fake = await fakeSupabase(page)
  const id = await serverProject(fake.server, "Live", { "a.md": "first" })
  await signedIn(page)
  await page.goto(projectUrl(id))
  await explorer(page)
  await expect(page.getByRole("button", { name: "a.md", exact: true })).toBeVisible()
  await expect(page.getByRole("status").filter({ hasText: "Synced" })).toBeVisible()

  const saved = await addFile(fake.server, id, "b.md", "from another device")
  fake.signal(id, saved.project.revision)
  await expect(page.getByRole("button", { name: "b.md", exact: true })).toBeVisible()
})

test("offline, a new project waits on this device and is sent when the connection returns", async ({ page }) => {
  const fake = await fakeSupabase(page)
  await signedIn(page)
  await home(page)
  fake.offline = true
  await page.getByLabel("New project").fill("Written offline")
  await page.getByRole("button", { name: "Create" }).click()
  await expect(page.getByRole("heading", { level: 1, name: "Written offline" })).toBeVisible()
  await expect(page.getByRole("status").filter({ hasText: "waiting to sync" })).toBeVisible()
  const id = new URL(page.url()).pathname.split("/")[2]
  // Let every attempt made while offline finish failing first.
  await quiet(fake)
  expect(fake.refused.length).toBeGreaterThan(0)
  expect(fake.server.projects.has(id)).toBe(false)

  fake.offline = false
  await page.evaluate(() => window.dispatchEvent(new Event("online")))
  await expect.poll(() => fake.server.projects.get(id)?.title).toBe("Written offline")
  await expect(page.getByRole("status").filter({ hasText: "Synced" })).toBeVisible()
})

/** Someone else's project, shared with `person`: an invitation, or accepted already. */
async function sharedWithMe(server: FakeProjectServer, title: string, files: Record<string, string>, accepted: boolean) {
  const owner = server.remote(SOMEONE_ELSE)
  const id = crypto.randomUUID()
  await owner.createProject(id, title)
  for (const [path, content] of Object.entries(files)) await owner.saveFiles(id, crypto.randomUUID(), [{ op: "put", path, content }])
  if (accepted) server.share(id, person.id, "editor")
  else server.invite(id, person.id, "editor")
  return id
}
const SOMEONE_ELSE = "5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f"

test("an invitation shows on the projects home, and accepting it opens the project", async ({ page }) => {
  const server = new FakeProjectServer()
  const id = await sharedWithMe(server, "Their notes", { "a.md": "# From them" }, false)
  await fakeSupabase(page, { server })
  await signedIn(page)
  await home(page)
  const invitations = page.getByRole("region", { name: "Invitations" })
  await expect(invitations.getByRole("listitem")).toHaveText(["Their notes, as editorAccept"])
  await expect(page.getByRole("link", { name: "Their notes" })).toHaveCount(0)

  await invitations.getByRole("button", { name: "Accept the invitation to Their notes" }).click()
  await expect(page).toHaveURL(projectUrl(id))
  await expect(page.getByRole("heading", { level: 1, name: "Their notes" })).toBeVisible()
  await explorer(page)
  await expect(page.getByRole("button", { name: "a.md", exact: true })).toBeVisible()
  expect(server.projects.get(id)!.members.get(person.id)?.accepted).toBe(true)

  await page.getByRole("link", { name: "Your projects" }).click()
  await expect(page.getByRole("link", { name: "Their notes" })).toBeVisible()
  await expect(page.getByRole("region", { name: "Invitations" })).toHaveCount(0)
})

test("leaving a shared project removes it from the list and from this device", async ({ page }) => {
  const server = new FakeProjectServer()
  const id = await sharedWithMe(server, "Their notes", { "a.md": "# From them" }, true)
  await fakeSupabase(page, { server })
  await signedIn(page)
  // Open it once, so it is on this device.
  await page.goto(projectUrl(id))
  await expect(page.getByRole("status").filter({ hasText: "Synced" })).toBeVisible({ timeout: 15_000 })
  await page.getByRole("link", { name: "Your projects" }).click()
  await expect(page.getByRole("link", { name: "Their notes" })).toBeVisible()

  let asked = ""
  page.once("dialog", (dialog) => {
    asked = dialog.message()
    void dialog.accept()
  })
  await page.getByRole("button", { name: "Actions for Their notes" }).click()
  await page.getByRole("menuitem", { name: "Leave project" }).click()
  await expect(page.getByText("Left Their notes.")).toBeVisible()
  expect(asked).toBe("Leave Their notes? You lose access to it, and it is removed from this device. Its owner can invite you again.")
  await expect(page.getByRole("link", { name: "Their notes" })).toHaveCount(0)
  expect(server.projects.get(id)!.members.has(person.id)).toBe(false)

  // Nothing of it is left here: a copy on this device would still be listed.
  await page.reload()
  await expect(page.getByRole("heading", { name: "Your projects" })).toBeVisible()
  await expect(page.getByText("No projects yet.")).toBeVisible()
})

test("leaving a shared project with an edit that has not synced is refused, naming the file", async ({ page }) => {
  const server = new FakeProjectServer()
  const id = await sharedWithMe(server, "Their notes", { "a.md": "# From them" }, true)
  const fake = await fakeSupabase(page, { server })
  await signedIn(page)
  await page.goto(projectUrl(id, "a.md"))
  await expect(page.getByRole("status").filter({ hasText: "Synced" })).toBeVisible({ timeout: 15_000 })

  // Saved on this device while offline, so the server does not have it.
  fake.offline = true
  await page.locator(".monaco-editor:visible .view-lines").first().click()
  await page.keyboard.press("ControlOrMeta+End")
  await page.keyboard.type(" and me")
  await page.keyboard.press("ControlOrMeta+s")
  await expect(page.getByRole("tab", { name: "a.md" }).getByLabel("unsaved changes")).toHaveCount(0)
  await page.getByRole("link", { name: "Your projects" }).click()
  const row = page.getByRole("listitem").filter({ hasText: "Their notes" })
  await expect(row).toContainText("Saved on this device, waiting to sync")

  page.once("dialog", (dialog) => void dialog.dismiss())
  await row.getByRole("button", { name: "Actions for Their notes" }).click()
  await page.getByRole("menuitem", { name: "Leave project" }).click()
  await expect(page.getByRole("alert").filter({ hasText: "Not left:" })).toHaveText(
    "Not left: Their notes has changes on this device that have not synced (a.md). Sync them first, so nothing is lost.",
  )
  await expect(page.getByRole("link", { name: "Their notes" })).toBeVisible()
  expect(server.projects.get(id)!.members.has(person.id)).toBe(true)
  expect(fake.requests.some((request) => request.url().endsWith("/rpc/leave_project"))).toBe(false)
})

test("the projects home does not download the editor", async ({ page }) => {
  // The editor (Monaco, Excalidraw, the note frame) loads only for a project.
  await fakeSupabase(page)
  await signedIn(page)
  const scripts: string[] = []
  page.on("request", (request) => {
    if (request.resourceType() === "script") scripts.push(new URL(request.url()).pathname)
  })
  await home(page)
  await page.waitForLoadState("networkidle")
  expect(scripts.length).toBeGreaterThan(0)
  expect(scripts.filter((script) => /\/(WorkspaceWorkbench|editor\.api)-[\w-]+\.js$/.test(script))).toEqual([])
})

test("links to projects that do not exist, or are not project links, say so", async ({ page }) => {
  await fakeSupabase(page)
  await signedIn(page)
  await page.goto(projectUrl(crypto.randomUUID()))
  await expect(page.getByRole("heading", { name: "Project not found" })).toBeVisible()
  await page.goto(new URL("projects/not-a-project/a.md", APP_URL).href)
  await expect(page.getByRole("alert")).toContainText("does not name a project")
})

test("a signed-out visitor to a project is asked to sign in and come back", async ({ page }) => {
  await fakeSupabase(page)
  const id = crypto.randomUUID()
  await page.goto(projectUrl(id, "a.md"))
  await page.getByRole("link", { name: "Sign in" }).click()
  await expect(page).toHaveURL(new URL(`sign-in?next=${encodeURIComponent(`/projects/${id}/a.md`)}`, APP_URL).href)
})

test("the project page has no accessibility violations", async ({ page }) => {
  const server = new FakeProjectServer()
  const id = await serverProject(server, "Checked", { "a.md": "text" })
  await fakeSupabase(page, { server })
  await signedIn(page)
  await page.goto(projectUrl(id, "a.md"))
  await expect(page.getByRole("tab", { name: "a.md" })).toBeVisible()
  await expect(page.getByText("text", { exact: true })).toBeVisible()
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations.map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => node.target) }))).toEqual([])
})
