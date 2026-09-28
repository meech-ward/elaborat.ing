import { expect, test, type Page } from "@playwright/test"
import { FakeProjectServer } from "../../src/features/project-storage/fakeServer.ts"
import { fakeSupabase, person, signedIn, type OAuthGrant } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

// The desktop side panels: search in the files panel, switching and sharing
// from the project panel, and the connected agents count in the account panel.

const projectUrl = (id: string, path?: string) => new URL(`projects/${id}${path ? `/${path}` : ""}`, APP_URL).href

async function serverProject(server: FakeProjectServer, title: string, files: Record<string, string>, owner = person.id) {
  const remote = server.remote(owner)
  const id = crypto.randomUUID()
  await remote.createProject(id, title)
  for (const [path, content] of Object.entries(files)) {
    await remote.saveFiles(id, crypto.randomUUID(), [{ op: "put", path, content }])
  }
  return id
}

async function openProject(page: Page, id: string, path?: string) {
  await page.goto(projectUrl(id, path))
  await expect(page.getByRole("status").filter({ hasText: "Synced" })).toBeVisible({ timeout: 15_000 })
}

test("search in the files panel finds this project's files by their text, and opens one", async ({ page }) => {
  const server = new FakeProjectServer()
  const id = await serverProject(server, "Product notes", {
    "notes/plan.md": "# Plan\n\nThe customer model comes first.",
    "flow.d2": "customer -> order",
    "readme.md": "# Readme",
    "sketches/board.excalidraw": JSON.stringify({
      type: "excalidraw",
      version: 2,
      elements: [{ id: "t", type: "text", x: 0, y: 0, width: 120, height: 25, text: "Checkout flow", originalText: "Checkout flow" }],
    }),
  })
  await serverProject(server, "Elsewhere", { "other.md": "Another customer" })
  const fake = await fakeSupabase(page, { server })
  await signedIn(page)
  await openProject(page, id)

  const field = page.getByRole("searchbox", { name: "Search notes, drawings and diagrams" })
  await field.fill("customer model")
  const results = page.getByRole("region", { name: "Search results" })
  await expect(results.getByRole("button")).toHaveCount(1)
  await expect(results.getByRole("button")).toContainText("notes/plan.md")
  await expect(results.locator("strong")).toHaveText("customer")
  expect(fake.requests.some((request) => request.url().endsWith("/functions/v1/search") && request.postDataJSON()?.projectId === id)).toBe(true)

  await field.fill("customer")
  await expect(results.getByRole("button")).toHaveCount(2)
  await results.getByRole("button", { name: /notes\/plan\.md/ }).click()
  await expect(page).toHaveURL(projectUrl(id, "notes/plan.md"))

  // Words written in a drawing find it, and its hit opens the drawing.
  await field.fill("checkout")
  await results.getByRole("button", { name: /sketches\/board\.excalidraw/ }).click()
  await expect(page).toHaveURL(projectUrl(id, "sketches/board.excalidraw"))
  await expect(page.locator(".excalidraw").first()).toBeVisible({ timeout: 15_000 })

  await field.fill("nothing like this")
  await expect(results.getByRole("status")).toHaveText("No files match.")
  await field.press("Escape")
  await expect(field).toHaveValue("")
  await expect(results).toHaveCount(0)
  await expect(page.getByRole("button", { name: "readme.md", exact: true })).toBeVisible()

  fake.offline = true
  await field.fill("customer")
  await expect(results.getByRole("status")).toHaveText("Search needs a connection.")

  // Over the searches a minute limit, the database's message shows as it is.
  fake.offline = false
  server.limited = "You have reached the limit of 120 searches a minute. Try again in 42 seconds."
  await field.fill("customer model")
  await expect(results.getByRole("status")).toHaveText(server.limited)
})

test("in the local project, search says to sign up", async ({ page }) => {
  await fakeSupabase(page)
  await page.goto(APP_URL)
  await page.getByRole("banner").getByRole("link", { name: "Start writing" }).click()
  await expect(page.getByRole("heading", { level: 1, name: "Local project" })).toBeVisible({ timeout: 15_000 })
  await page.getByRole("searchbox", { name: "Search notes, drawings and diagrams" }).fill("anything")
  const results = page.getByRole("region", { name: "Search results" })
  await expect(results.getByRole("link", { name: "Sign up to search" })).toHaveAttribute("href", "/sign-up")
})

test("the project panel switches to another project and back to all projects", async ({ page }) => {
  const server = new FakeProjectServer()
  const alpha = await serverProject(server, "Alpha", { "a.md": "# A" })
  const beta = await serverProject(server, "Beta", { "b.md": "# B" })
  const old = await serverProject(server, "Old", {})
  await server.remote(person.id).archiveProject(old)
  await fakeSupabase(page, { server })
  await signedIn(page)
  await openProject(page, alpha, "a.md")

  // The project's name opens its menu: the projects, the way home, then the project's actions.
  await page.getByRole("button", { name: "Alpha, project menu" }).click()
  const menu = page.getByRole("menu")
  await expect(menu.getByRole("menuitem")).toHaveText(["Alpha", "Beta", "All projects", "Download project", "Import a file", "Refresh file list", "Command palette"])
  await expect(menu.getByRole("menuitem", { name: "Alpha" })).toHaveAttribute("aria-current", "page")
  await menu.getByRole("menuitem", { name: "Beta" }).click()
  await expect(page).toHaveURL(projectUrl(beta))
  await expect(page.getByRole("heading", { level: 1, name: "Beta" })).toBeVisible()

  await page.getByRole("button", { name: "Beta, project menu" }).click()
  await page.getByRole("menu").getByRole("menuitem", { name: "All projects" }).click()
  await expect(page.getByRole("heading", { name: "Your projects" })).toBeVisible()
})

test("the owner shares a project from its page; a viewer has no Share button", async ({ page }) => {
  const server = new FakeProjectServer()
  const MEMBER = "6e7f8091-ab2c-4d3e-8f4a-5b6c7d8e9fa0"
  const OTHER = "5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f"
  server.emails.set(MEMBER, "member@example.com")
  const mine = await serverProject(server, "Team notes", { "a.md": "# A" })
  server.share(mine, MEMBER, "editor")
  const theirs = await serverProject(server, "Their notes", { "b.md": "# B" }, OTHER)
  server.share(theirs, person.id, "viewer")
  await fakeSupabase(page, { server })
  await signedIn(page)

  await openProject(page, mine)
  await page.getByRole("button", { name: "Share project" }).click()
  const dialog = page.getByRole("dialog", { name: "Members of Team notes" })
  await dialog.getByLabel("Role for member@example.com").click()
  await page.getByRole("option", { name: "Viewer", exact: true }).click()
  await expect(dialog.getByRole("status")).toHaveText("member@example.com is now a viewer.")
  expect(server.projects.get(mine)!.members.get(MEMBER)?.role).toBe("viewer")
  await dialog.getByRole("button", { name: "Close" }).click()
  await expect(dialog).toHaveCount(0)

  await openProject(page, theirs)
  await expect(page.getByRole("heading", { level: 1, name: "Their notes" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Share project" })).toHaveCount(0)
})

const grant = (id: string, name: string): OAuthGrant => ({
  client: { id, name, uri: "https://example.com", logo_uri: "" },
  scopes: ["email"],
  granted_at: "2026-09-20T15:30:00Z",
})

test("the account panel shows how many agents are connected, and none when there are none", async ({ page }) => {
  const server = new FakeProjectServer()
  const id = await serverProject(server, "Product notes", { "a.md": "# A" })
  const grants = [grant("client-claude", "Claude"), grant("client-chatgpt", "ChatGPT")]
  await fakeSupabase(page, { server, grants })
  await signedIn(page)
  await openProject(page, id)
  // The count describes the link.
  const link = page.getByRole("link", { name: "Connected agents", exact: true })
  await expect(link).toBeVisible()
  await expect(link).toHaveAttribute("href", "/agents")
  await expect(link).toHaveAccessibleDescription("2")

  grants.length = 0
  await page.reload()
  await expect(link).toBeVisible()
  await expect(link).not.toHaveAttribute("aria-describedby")
})
