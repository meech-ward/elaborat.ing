import { expect, test, type Page } from "@playwright/test"
import { fakeSupabase, person, quiet, type FakeSupabase } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

// Without an account: one local project kept in this browser, what needs an
// account shown locked, and on signing in the local project moves to the
// account, against the stand-in Supabase.

test.describe.configure({ timeout: 60_000 })

const editorText = (page: Page) => page.locator(".monaco-editor:visible .view-lines").first()
const creates = (fake: FakeSupabase) => fake.requests.filter((request) => new URL(request.url()).pathname.endsWith("/rpc/create_project")).length

async function startWriting(page: Page) {
  await page.goto(APP_URL)
  await expect(page.getByText("saved in this browser only")).toBeVisible()
  await page.getByRole("banner").getByRole("link", { name: "Start writing" }).click()
  await expect(page.getByRole("heading", { level: 1, name: "Local project" })).toBeVisible({ timeout: 15_000 })
}

/** Make a note named `name` holding `text`, and save it. */
async function writeNote(page: Page, name: string, text: string) {
  await page.getByRole("button", { name: "New note", exact: true }).click()
  await page.keyboard.type(name)
  await page.keyboard.press("Enter")
  await expect(page.getByRole("tab", { name: `${name}.md` })).toBeVisible()
  await editorText(page).click()
  await page.keyboard.type(text)
  await page.keyboard.press("ControlOrMeta+s")
  await expect(page.getByRole("tab", { name: `${name}.md, unsaved changes` })).toHaveCount(0)
}

async function signIn(page: Page) {
  await page.goto(new URL("sign-in", APP_URL).href)
  await page.getByRole("button", { name: "Use a password instead" }).click()
  await page.getByLabel("Email", { exact: true }).fill(person.email)
  await page.getByLabel("Password", { exact: true }).fill("a password")
  await page.getByRole("button", { name: "Sign in" }).click()
}

test("without an account, the local project keeps a note across a reload, and what needs an account says sign up", async ({ page }) => {
  const fake = await fakeSupabase(page)
  await startWriting(page)
  await expect(page.getByRole("status").filter({ hasText: "Saved in this browser" }).first()).toBeVisible()
  await expect(page.getByRole("link", { name: "Sign up to create projects" })).toHaveAttribute("href", "/sign-up")
  await expect(page.getByRole("link", { name: "Sign up to share" })).toHaveAttribute("href", "/sign-up")
  await expect(page.getByRole("link", { name: "Sign up to connect agents" })).toHaveAttribute("href", "/sign-up")

  await writeNote(page, "ideas", "Kept in this browser.")
  await page.reload()
  await expect(page.getByRole("tab", { name: "ideas.mdx" })).toBeVisible({ timeout: 15_000 })
  await expect(editorText(page)).toContainText("Kept in this browser.")
  expect(creates(fake)).toBe(0)

  // Comments need an account too.
  await page.getByRole("button", { name: "Comments", exact: true }).click()
  await expect(page.getByRole("complementary", { name: "Comments" }).getByRole("link", { name: "Sign up to comment" })).toHaveAttribute("href", "/sign-up")
})

test("signing in uploads the local project once, as Local project, and opens it", async ({ page }) => {
  const fake = await fakeSupabase(page)
  const earlier = crypto.randomUUID()
  await fake.server.remote(person.id).createProject(earlier, "Earlier")
  await startWriting(page)
  const localUrl = page.url()
  await writeNote(page, "ideas", "Written before signing up.")

  await signIn(page)
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/)
  expect(page.url()).not.toBe(localUrl)
  const id = new URL(page.url()).pathname.split("/")[2]
  await expect(page.getByRole("heading", { level: 1, name: "Local project" })).toBeVisible({ timeout: 15_000 })
  await expect.poll(() => fake.server.content(id, "ideas.mdx")).toBe("Written before signing up.")
  expect(fake.server.projects.get(id)?.title).toBe("Local project")

  await page.goto(APP_URL)
  await expect(page.getByRole("link", { name: "Local project" })).toHaveCount(1)
  await expect(page.getByRole("link", { name: "Earlier" })).toBeVisible()
  await quiet(fake)
  expect(creates(fake)).toBe(1)
  expect([...fake.server.projects.values()].map((project) => project.title).sort()).toEqual(["Earlier", "Local project"])
})

test("an empty local project uploads nothing", async ({ page }) => {
  const fake = await fakeSupabase(page)
  await startWriting(page)
  await signIn(page)
  await expect(page.getByRole("heading", { name: "Your projects" })).toBeVisible()
  await expect(page.getByText("No projects yet.")).toBeVisible()
  await quiet(fake)
  expect(creates(fake)).toBe(0)
  expect(new URL(page.url()).pathname).toBe("/")
})
