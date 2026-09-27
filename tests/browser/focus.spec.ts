import { expect, test, type Page } from "@playwright/test"
import { fakeSupabase, person, signedIn } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

// Focus mode (desktop): only the file and its controls, and a way out.

test.describe.configure({ timeout: 60_000 })

async function openNote(page: Page) {
  const fake = await fakeSupabase(page)
  const id = crypto.randomUUID()
  const remote = fake.server.remote(person.id)
  await remote.createProject(id, "Notes")
  await remote.saveFiles(id, crypto.randomUUID(), [{ op: "put", path: "a.md", content: "# A\n" }, { op: "put", path: "notes/b.md", content: "# B\n" }])
  await signedIn(page)
  await page.goto(new URL(`projects/${id}/a.md`, APP_URL).href)
  await expect(page.getByRole("status").filter({ hasText: "Synced" })).toBeVisible({ timeout: 15_000 })
}

test("focus mode hides the side panels and tabs, and Exit full screen brings them back", async ({ page }) => {
  await openNote(page)
  const files = page.getByRole("navigation", { name: "Workspace files" })
  const tab = page.getByRole("tab", { name: "a.md" })
  await expect(files).toBeVisible()
  await page.keyboard.press("ControlOrMeta+Period")
  await expect(files).toHaveCount(0)
  await expect(tab).toBeHidden()
  await expect(page.getByRole("button", { name: "Source" })).toBeVisible()
  await page.getByRole("button", { name: "Exit full screen" }).click()
  await expect(files).toBeVisible()
  await expect(tab).toBeVisible()
  await page.getByRole("button", { name: "Focus" }).click()
  await expect(files).toHaveCount(0)
})

test("Cmd+P finds a file and opens it", async ({ page }) => {
  await openNote(page)
  await page.keyboard.press("ControlOrMeta+p")
  const search = page.getByLabel("Search files").first()
  await expect(search).toBeFocused()
  await search.fill("b.md")
  await page.keyboard.press("Enter")
  await expect(page.getByRole("tab", { name: "notes/b.md" })).toHaveAttribute("aria-selected", "true")
})

test("Cmd+P lists a diagram but not its generated files; Cmd+K switches to the commands and closes them", async ({ page }) => {
  const fake = await fakeSupabase(page)
  const id = crypto.randomUUID()
  const remote = fake.server.remote(person.id)
  await remote.createProject(id, "Notes")
  await remote.saveFiles(id, crypto.randomUUID(), [
    { op: "put", path: "a.md", content: "# A\n" },
    { op: "put", path: "flows/signup.d2", content: "a -> b\n" },
    { op: "put", path: "flows/signup.d2.json", content: "{}\n" },
    { op: "put", path: "flows/signup.excalidraw", content: "{}\n" },
  ])
  await signedIn(page)
  await page.goto(new URL(`projects/${id}/a.md`, APP_URL).href)
  await expect(page.getByRole("status").filter({ hasText: "Synced" })).toBeVisible({ timeout: 15_000 })

  await page.keyboard.press("ControlOrMeta+p")
  const palette = page.getByRole("dialog", { name: "Go to file" })
  await palette.getByLabel("Search files").fill("signup")
  await expect(palette.getByRole("option")).toHaveText(["2signup.d2flows"])
  await expect(palette).toContainText("commands")
  await expect(palette).not.toContainText("to the side")

  await page.keyboard.press("ControlOrMeta+k")
  const commands = page.getByRole("dialog", { name: "Commands" })
  await expect(commands.getByLabel("Search commands")).toBeFocused()
  await expect(commands.getByLabel("Search commands")).toHaveValue("")
  await expect(commands.getByRole("option", { name: "New note" })).toBeVisible()
  await page.keyboard.press("ControlOrMeta+k")
  await expect(commands).toHaveCount(0)
})
