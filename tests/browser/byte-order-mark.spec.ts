import { expect, test, type Page } from "@playwright/test"
import { fakeSupabase, person, signedIn } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

// A file saved with a UTF-8 byte order mark opens with nothing to save, in
// Source and in Rendered, and saving an edit keeps the mark, the line endings
// and every other byte as they were.

test.describe.configure({ timeout: 60_000 })

const FRAME = 'iframe[title="Isolated document preview"]'
const BOM = "﻿"

async function open(page: Page, path: string, content: string) {
  const fake = await fakeSupabase(page)
  const id = crypto.randomUUID()
  const remote = fake.server.remote(person.id)
  await remote.createProject(id, "Notes")
  await remote.saveFiles(id, crypto.randomUUID(), [{ op: "put", path, content }])
  await signedIn(page)
  await page.goto(new URL(`projects/${id}/${path}`, APP_URL).href)
  await expect(page.getByRole("status").filter({ hasText: "Synced" })).toBeVisible({ timeout: 15_000 })
  return { fake, id }
}

test("a note with a byte order mark opens unchanged in Source and Rendered, and a save keeps the mark", async ({ page }) => {
  const note = `${BOM}# Café \u{1F600}\r\n\r\nFirst paragraph \u{1F389} here.\r\n`
  const { fake, id } = await open(page, "notes/bom.md", note)
  const save = page.getByRole("button", { name: "Save", exact: true })
  const source = page.locator(".monaco-editor:visible .view-lines").first()
  await expect(source).toContainText("First paragraph")
  await expect(save).toHaveCount(0)

  await page.getByRole("button", { name: "Rendered" }).click()
  const first = page.frameLocator(FRAME).locator("p").filter({ hasText: "First paragraph" })
  await expect(first).toBeVisible()
  await expect(page.getByText("Render error:")).toHaveCount(0)
  await expect(save).toHaveCount(0)

  await first.click()
  await page.keyboard.press("End")
  await page.keyboard.type(" Rendered.")
  await expect(save).toBeVisible()
  await save.click()
  await expect(save).toHaveCount(0)
  const edited = `${BOM}# Café \u{1F600}\r\n\r\nFirst paragraph \u{1F389} here. Rendered.\r\n`
  await expect.poll(() => fake.server.content(id, "notes/bom.md")).toBe(edited)

  await page.getByRole("button", { name: "Source" }).click()
  await expect(save).toHaveCount(0)
  await source.click()
  await page.keyboard.press("ControlOrMeta+End")
  await page.keyboard.type("Source.")
  await save.click()
  await expect(save).toHaveCount(0)
  await expect.poll(() => fake.server.content(id, "notes/bom.md")).toBe(`${edited}Source.`)
})

test("a .csv with a byte order mark opens with nothing to save, and a save keeps the mark", async ({ page }) => {
  const table = `${BOM}name,mood\r\nAda,\u{1F600}\r\n`
  const { fake, id } = await open(page, "data/people.csv", table)
  const save = page.getByRole("button", { name: "Save", exact: true })
  const source = page.locator(".monaco-editor:visible .view-lines").first()
  await expect(source).toContainText("Ada")
  await expect(save).toHaveCount(0)
  await source.click()
  await page.keyboard.press("ControlOrMeta+End")
  await page.keyboard.type("Grace,ok")
  await save.click()
  await expect(save).toHaveCount(0)
  await expect.poll(() => fake.server.content(id, "data/people.csv")).toBe(`${table}Grace,ok`)
})
