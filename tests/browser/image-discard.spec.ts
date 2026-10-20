import { expect, test } from "./fixtures.ts"
import { fakeSupabase } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64")
test.use({ viewport: { width: 1280, height: 900 } })
test.describe.configure({ timeout: 60_000 })

for (const mode of ["discard", "undo", "save-image"] as const) test(`image drafts survive only an explicit standalone Save when closing a note: ${mode}`, async ({ page }) => {
  const undo = mode === "undo"
  const saveImage = mode === "save-image"
  await fakeSupabase(page)
  await page.goto(APP_URL)
  await page.getByRole("banner").getByRole("link", { name: "Start writing" }).click()
  await page.getByRole("button", { name: "New file", exact: true }).click()
  await page.getByRole("menuitem", { name: "New note", exact: true }).click()
  await page.getByRole("textbox", { name: /^Name of the new note in / }).fill("discard-image.mdx")
  await page.keyboard.press("Enter")
  const source = page.locator(".monaco-editor:visible .view-lines").first()
  await expect(source).toBeVisible()
  await source.click()
  await page.keyboard.type("Anchor paragraph.\n\nAfter paragraph.\n")
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect(page.getByRole("tab", { name: "discard-image.mdx", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Rendered", exact: true }).click()
  const frame = page.frameLocator('iframe[title="Isolated document preview"]:visible')
  await frame.getByText("Anchor paragraph.", { exact: true }).click({ button: "right" })
  await frame.getByRole("menuitem", { name: "Image", exact: true }).click()
  const picker = page.getByRole("dialog", { name: "Insert image", exact: true })
  await picker.getByLabel("Upload images", { exact: true }).setInputFiles({ name: "orphan.png", mimeType: "image/png", buffer: png })
  await expect(picker.getByLabel("Image description", { exact: true })).toBeEnabled()
  await picker.getByLabel("Image description", { exact: true }).fill("An unsaved image")
  await picker.getByRole("button", { name: "Insert image", exact: true }).click()
  const image = frame.getByRole("img", { name: "An unsaved image", exact: true })
  await expect(image).toBeVisible()
  const folder = page.getByRole("button", { name: "images", exact: true })
  if (await folder.getAttribute("aria-expanded") === "false") await folder.click()
  await expect(page.getByRole("button", { name: /^Actions for images\/orphan/ })).toHaveCount(1)
  if (saveImage) {
    await page.getByRole("button", { name: "images/orphan.png", exact: true }).click()
    await page.getByRole("button", { name: "Save", exact: true }).click()
    await expect(page.getByRole("tab", { name: "images/orphan.png", exact: true })).toBeVisible()
    await page.getByRole("tab", { name: "discard-image.mdx, unsaved changes", exact: true }).click()
  }
  if (undo) {
    await frame.getByText("After paragraph.", { exact: true }).click()
    await page.keyboard.press("ControlOrMeta+z")
    await expect(image).toHaveCount(0)
  }
  const tab = page.getByRole("tab", { name: undo ? "discard-image.mdx" : "discard-image.mdx, unsaved changes", exact: true })
  const confirmation = undo ? null : page.waitForEvent("dialog").then(async dialog => {
    expect(dialog.message()).toContain("discard unsaved changes")
    await dialog.accept()
  })
  await tab.hover()
  await tab.locator('[data-slot="tab-close"]').click()
  await confirmation
  await expect(page.getByRole("tab", { name: /discard-image\.mdx/ })).toHaveCount(0)
  await expect(page.getByRole("button", { name: /^Actions for images\/orphan/ })).toHaveCount(saveImage ? 1 : 0)
  await page.reload()
  await expect(page.getByRole("navigation", { name: "Workspace files" })).toBeVisible()
  await expect(page.getByRole("button", { name: /^Actions for images\/orphan/ })).toHaveCount(saveImage ? 1 : 0)
})
