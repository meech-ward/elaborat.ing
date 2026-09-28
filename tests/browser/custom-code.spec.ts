import { expect, test, type Page } from "@playwright/test"
import type { Role } from "../../src/features/project-storage/model.ts"
import { FakeProjectServer } from "../../src/features/project-storage/fakeServer.ts"
import { fakeSupabase, person, signedIn, type FakeSupabase } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"
import { showView } from "./views.ts"

// A note in a project shared with the person that runs custom components
// (imported from the project's files, or exported by the note) waits behind
// a notice: who last changed the files, where the code runs, and Run
// components or Show as text. The choice holds on this device until a
// component file changes. The person's own projects, and built-in
// components, never ask.

test.describe.configure({ timeout: 60_000 })

const SOMEONE_ELSE = "5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f"
const MODULE = "ui/card.mdx"
const PREVIEW = 'iframe[title="Isolated document preview"]'
const card = (words: string) => `export const ReleaseCard = ({ title }) => <section className="card"><h3>{title}</h3><p>${words}</p></section>\n`
const NOTE = `import { ReleaseCard } from "workspace:${MODULE}"\n\n# Plan\n\n<ReleaseCard title="Launch" />\n`
const BUILT_IN = "# Plain\n\n<Counter initial={2} />\n"
const projectUrl = (id: string, path: string) => new URL(`projects/${id}/${path}`, APP_URL).href
const notice = (page: Page) => page.getByText("This note runs custom components")
const shownCard = (page: Page) => page.frameLocator(PREVIEW).locator("section.card")

/** A project with the card component and a note using it, owned by `owner` and shared with the person unless they own it. */
async function openProject(page: Page, path: string, owner = SOMEONE_ELSE, role: Exclude<Role, "owner"> = "editor") {
  const server = new FakeProjectServer()
  server.names.set(SOMEONE_ELSE, "Ana")
  const id = crypto.randomUUID()
  await server.remote(owner).createProject(id, "Notes")
  await server.remote(owner).saveFiles(id, crypto.randomUUID(), [
    { op: "put", path: MODULE, content: card("First version") },
    { op: "put", path: "notes/plan.mdx", content: NOTE },
    { op: "put", path: "notes/plain.mdx", content: BUILT_IN },
  ])
  if (owner !== person.id) server.share(id, person.id, role)
  const fake = await fakeSupabase(page, { server })
  await signedIn(page)
  await page.goto(projectUrl(id, path))
  await expect(page.getByRole("tab", { name: path })).toBeVisible({ timeout: 15_000 })
  await showView(page, "Rendered")
  return { fake, id }
}

/** The component file changed by its owner on another device, announced to the open project. */
async function changeElsewhere(fake: FakeSupabase, id: string, content: string) {
  const version = fake.server.projects.get(id)!.files.get(MODULE)!.version
  const saved = await fake.server.remote(SOMEONE_ELSE).saveFiles(id, crypto.randomUUID(), [{ op: "put", path: MODULE, content, base_version: version }])
  if (saved.status === "saved") fake.signal(id, saved.project.revision)
}

test("a shared note asks before running its components, runs them when asked, and the choice holds across a reload", async ({ page }) => {
  await openProject(page, "notes/plan.mdx")
  await expect(notice(page)).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole("list", { name: "Files with component code" })).toHaveText("ui/card.mdx, last changed by Ana")
  await expect(page.getByText("They run in an isolated frame, with no network and no access to your account.", { exact: false })).toBeVisible()
  await expect(page.locator(PREVIEW)).toHaveCount(0)

  await page.getByRole("button", { name: "Run components" }).click()
  await expect(shownCard(page).locator("h3")).toHaveText("Launch", { timeout: 15_000 })
  await expect(notice(page)).toHaveCount(0)

  await page.reload()
  await showView(page, "Rendered")
  await expect(shownCard(page).locator("p")).toHaveText("First version", { timeout: 15_000 })
  await expect(notice(page)).toHaveCount(0)
})

test("a component file changed by someone else asks again, and runs its new version when asked", async ({ page }) => {
  const { fake, id } = await openProject(page, "notes/plan.mdx", SOMEONE_ELSE, "viewer")
  await page.getByRole("button", { name: "Run components" }).click()
  await expect(shownCard(page).locator("p")).toHaveText("First version", { timeout: 15_000 })

  await changeElsewhere(fake, id, card("Second version"))
  await expect(notice(page)).toBeVisible({ timeout: 15_000 })
  await expect(page.locator(PREVIEW)).toHaveCount(0)
  await page.getByRole("button", { name: "Run components" }).click()
  await expect(shownCard(page).locator("p")).toHaveText("Second version", { timeout: 15_000 })
})

test("Show as text opens the note's source instead", async ({ page }) => {
  await openProject(page, "notes/plan.mdx")
  await page.getByRole("button", { name: "Show as text" }).click()
  await expect(page.locator(".monaco-editor:visible .view-lines").first()).toContainText("workspace:ui/card.mdx")
  await expect(notice(page)).toBeHidden()
})

test("built-in components in a shared project, and the person's own projects, never ask", async ({ page, context }) => {
  await openProject(page, "notes/plain.mdx")
  await expect(page.frameLocator(PREVIEW).locator('[data-component="Counter"]')).toBeVisible({ timeout: 15_000 })
  await expect(notice(page)).toHaveCount(0)

  const own = await context.newPage()
  await openProject(own, "notes/plan.mdx", person.id)
  await expect(shownCard(own).locator("h3")).toHaveText("Launch", { timeout: 15_000 })
  await expect(notice(own)).toHaveCount(0)
})
