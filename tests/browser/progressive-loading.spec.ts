import { expect, test } from "./fixtures.ts"
import { fakeSupabase, person, signedIn } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"
import { showView } from "./views.ts"
import { recordReadiness } from "./readiness.ts"

test.describe.configure({ timeout: 60_000 })

test("home, requested Source, cached Rendered and expanded documents have separate useful milestones", async ({ page }, testInfo) => {
  const fake = await fakeSupabase(page)
  const remote = fake.server.remote(person.id)
  const project = crypto.randomUUID()
  await remote.createProject(project, "Readiness fixtures")
  await remote.saveFiles(project, crypto.randomUUID(), [
    { op: "put", path: "parent.mdx", content: '# Ready parent\n\nIndependent prose.\n\n<Document src="child.md" title="Details" defaultCollapsed />\n' },
    { op: "put", path: "child.md", content: "# Ready child\n\nExpanded content.\n" },
  ])
  await signedIn(page)
  await page.goto(APP_URL)
  await expect(page.getByRole("link", { name: "Readiness fixtures", exact: true })).toBeVisible()
  await recordReadiness(page, testInfo, "project-home")

  const url = new URL(`projects/${project}/parent.mdx`, APP_URL).href
  await page.goto(url)
  await showView(page, "Source")
  await expect(page.locator(".monaco-editor:visible .view-lines").first()).toContainText("Independent prose.")
  const source = await recordReadiness(page, testInfo, "requested-source")
  // A generous CI ceiling catches a hung document. Delayed-dependency tests
  // enforce useful ordering independently of machine speed.
  expect(source.usefulContentMs).toBeLessThan(20_000)
  await expect(page.getByRole("status", {name: "Synced", exact: true})).toBeVisible()

  await page.reload()
  await showView(page, "Rendered")
  const frame = page.frameLocator('iframe[title="Isolated document preview"]:visible')
  await expect(frame.getByText("Independent prose.", {exact:true})).toBeVisible()
  await recordReadiness(page, testInfo, "cached-rendered")
  const child = frame.locator('[data-document-embed="child.md"]')
  await expect(child).toBeVisible()
  await expect(child.locator("iframe")).toHaveCount(0)
  await child.getByRole("button", {name: "Details", exact: true}).click()
  await expect(child.frameLocator("iframe").getByText("Expanded content.", {exact:true})).toBeVisible()
  await recordReadiness(page, testInfo, "expanded-document")
})
