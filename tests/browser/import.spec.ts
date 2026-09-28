import { expect, test, type Page } from "@playwright/test"
import { fakeSupabase, signedIn, type FakeSupabase } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

// Importing a project exported from the prototype: one JSON file that
// becomes a new project on this device, then syncs to the server byte for
// byte. Paths this app cannot store are skipped and listed.

test.describe.configure({ timeout: 60_000 })

const files = [
  { path: "notes/intro.mdx", content: 'import { Badge } from "workspace:components/badge.mdx"\r\n\r\n# Intro\r\n\r\nKept byte for byte.\t🙂 <Badge />' },
  { path: "components/badge.mdx", content: 'export const Badge = () => <span className="badge">new</span>\n' },
  { path: "drawings/sketch.excalidraw", content: '{"type":"excalidraw","version":2,"source":"prototype","elements":[],"appState":{},"files":{}}' },
  { path: "diagrams/flow.d2", content: "idea -> draft -> done\n" },
  { path: "diagrams/flow.excalidraw", content: '{"type":"excalidraw","version":2,"elements":[]}' },
  { path: "diagrams/flow.d2.json", content: '{"version":1,"source":"diagrams/flow.d2"}' },
]
const folders = ["components", "diagrams", "drawings", "empty-folder", "notes"]
const skipped = [
  { path: "notes/café.md", reason: "The path is not in Unicode normal form C (NFC)." },
  { path: ".obsidian/workspace.json", reason: "A name in the path starts with a dot." },
  { path: `archive/${"a-very-long-folder-name-without-any-spaces-".repeat(4)}/old:notes.md`, reason: "The path has a backslash or a colon." },
]
const exported = {
  format: "diagramming-project",
  version: 1,
  title: "From the prototype",
  files: [...files, ...skipped.map(({ path }) => ({ path, content: "skipped\n" }))],
  directories: folders,
}
const exportFile = (name: string, value: unknown) => ({ name, mimeType: "application/json", buffer: Buffer.from(JSON.stringify(value)) })

async function home(page: Page) {
  const fake = await fakeSupabase(page)
  await signedIn(page)
  await page.goto(APP_URL)
  await expect(page.getByRole("heading", { name: "Your projects" })).toBeVisible()
  return fake
}

/** Import the fixture and return the new project's id from the report's link. */
async function importFixture(page: Page) {
  await page.getByLabel("Import a prototype export").setInputFiles(exportFile("notes.json", exported))
  const report = page.getByRole("status").filter({ hasText: "Imported" })
  await expect(report).toContainText("Imported From the prototype: 6 files and 5 folders.")
  const href = await report.getByRole("link", { name: "From the prototype" }).getAttribute("href")
  return { report, id: /\/projects\/([0-9a-f-]{36})$/.exec(href ?? "")![1] }
}

async function onServer(fake: FakeSupabase, id: string) {
  for (const file of files) await expect.poll(() => fake.server.content(id, file.path)).toBe(file.content)
  expect(fake.server.paths(id)).toEqual(files.map((file) => file.path).sort())
  await expect.poll(() => [...fake.server.projects.get(id)!.folders].sort()).toEqual(folders)
}

test("an export becomes a new project with every byte, and paths this app cannot store are listed", async ({ page }) => {
  const fake = await home(page)
  const { report, id } = await importFixture(page)
  await expect(report.getByRole("listitem")).toHaveText(skipped.map(({ path, reason }) => `${path} ${reason}`))
  await expect(page.getByRole("link", { name: "From the prototype" }).first()).toBeVisible()
  await onServer(fake, id)

  // Open the imported note.
  await report.getByRole("link", { name: "From the prototype" }).click()
  await expect(page.getByRole("heading", { level: 1, name: "From the prototype" })).toBeVisible()
  await expect(page.getByRole("navigation", { name: "Workspace files" }).first()).toBeVisible()
  await page.getByRole("button", { name: "notes", exact: true, expanded: false }).click()
  await page.getByRole("button", { name: "notes/intro.mdx", exact: true }).click()
  await expect(page.getByRole("tab", { name: "notes/intro.mdx" })).toHaveAttribute("aria-selected", "true")
  await expect(page.locator(".monaco-editor:visible .view-lines").first()).toContainText("Kept byte for byte.")
})

test("an export that fails the checks says why, and creates nothing", async ({ page }) => {
  const fake = await home(page)
  await page.getByLabel("Import a prototype export").setInputFiles(exportFile("later.json", { ...exported, version: 2 }))
  await expect(page.getByRole("alert")).toHaveText("later.json could not be imported. Only version 1 of the prototype's export can be imported.")
  await page.getByLabel("Import a prototype export").setInputFiles(exportFile("twice.json", { ...exported, files: [...files, files[0]] }))
  await expect(page.getByRole("alert")).toHaveText("twice.json could not be imported. notes/intro.mdx appears more than once.")
  await expect(page.getByText("No projects yet.")).toBeVisible()
  expect(fake.server.projects.size).toBe(0)
})

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test("the import control and the report of skipped paths fit without sideways scrolling", async ({ page }) => {
    const fake = await home(page)
    const fits = () => document.documentElement.scrollWidth <= innerWidth + 1
    expect(await page.evaluate(fits)).toBe(true)
    const { report, id } = await importFixture(page)
    await expect(report.getByRole("listitem")).toHaveCount(skipped.length)
    expect(await page.evaluate(fits)).toBe(true)
    await onServer(fake, id)
  })
})
