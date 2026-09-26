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
  await page.getByRole("link", { name: "notes/a b.md" }).click()
  await expect(page).toHaveURL(projectUrl(id, "notes/a%20b.md"))
  await expect(page.getByText("spaces in the name")).toBeVisible()

  // The file's URL works on its own too.
  await page.goto(projectUrl(id, "readme.md"))
  await expect(page.getByText("# Hello")).toBeVisible()
})

test("a change made elsewhere arrives when the server signals it", async ({ page }) => {
  const fake = await fakeSupabase(page)
  const id = await serverProject(fake.server, "Live", { "a.md": "first" })
  await signedIn(page)
  await page.goto(projectUrl(id))
  await expect(page.getByRole("link", { name: "a.md" })).toBeVisible()
  await expect(page.getByRole("status").filter({ hasText: "Synced" })).toBeVisible()

  const saved = await addFile(fake.server, id, "b.md", "from another device")
  fake.signal(id, saved.project.revision)
  await expect(page.getByRole("link", { name: "b.md" })).toBeVisible()
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
  await expect(page.getByText("text", { exact: true })).toBeVisible()
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations.map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => node.target) }))).toEqual([])
})
