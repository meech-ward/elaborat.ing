import { expect, test, type Page } from "./fixtures.ts"
import { fakeSupabase } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=="
const frame = (page: Page) => page.frameLocator('iframe[title="Isolated document preview"]:visible')
test.use({ viewport: { width: 1280, height: 900 } })
test.describe.configure({ timeout: 60_000 })

for (const gesture of ["paste", "drop"] as const) test(`rendered ${gesture} opens the trusted image picker, preserves Cancel and saves portable bytes`, async ({ page }) => {
  await fakeSupabase(page)
  await page.goto(APP_URL)
  await page.getByRole("banner").getByRole("link", { name: "Start writing" }).click()
  await page.getByRole("button", { name: "New file", exact: true }).click()
  await page.getByRole("menuitem", { name: "New note", exact: true }).click()
  await page.getByRole("textbox", { name: /^Name of the new note in / }).fill("ingestion.mdx")
  await page.keyboard.press("Enter")
  const source = page.locator(".monaco-editor:visible .view-lines").first()
  await expect(source).toBeVisible()
  await source.click()
  await page.keyboard.type("Anchor paragraph.\n\nAfter paragraph.\n")
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect(page.getByRole("tab", { name: "ingestion.mdx", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Rendered", exact: true }).click()
  const ingest = async () => {
    const paragraph = frame(page).getByText("Anchor paragraph.", { exact: true })
    await paragraph.click()
    await paragraph.evaluate((target, { gesture, png }) => {
      const transfer = new DataTransfer()
      transfer.items.add(new File([Uint8Array.from(atob(png), character => character.charCodeAt(0))], `${gesture}.png`, { type: "image/png" }))
      if (gesture === "paste") {
        const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer })
        // Give the synthetic event the same clipboard bytes in every browser.
        Object.defineProperty(event, "clipboardData", { value: transfer })
        target.dispatchEvent(event)
      }
      else {
        const bounds = target.getBoundingClientRect()
        target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: bounds.left + 8, clientY: bounds.top + bounds.height / 2 }))
      }
    }, { gesture, png })
    const picker = page.getByRole("dialog", { name: "Insert image", exact: true })
    await expect(picker).toBeVisible()
    await expect(picker.getByLabel("Image description", { exact: true })).toBeEnabled()
    return picker
  }
  const cancelled = await ingest()
  await expect(cancelled.getByText(new RegExp(`${gesture}\\.png`))).toBeVisible()
  await cancelled.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(frame(page).locator("img")).toHaveCount(0)
  await expect(page.getByRole("tab", { name: "ingestion.mdx", exact: true })).toBeVisible()
  const picker = await ingest()
  await picker.getByLabel("Image description", { exact: true }).fill(`A ${gesture} image`)
  await picker.getByRole("button", { name: "Insert image", exact: true }).click()
  await expect(frame(page).getByRole("button", { name: `View image: A ${gesture} image`, exact: true }).locator("img")).toBeVisible()
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect(page.getByRole("tab", { name: "ingestion.mdx", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Source", exact: true }).click()
  await expect(source).toContainText(`![A ${gesture} image](images/${gesture}.png)`)
  await expect(source).not.toContainText("data:image")
  await page.reload()
  await expect(source).toContainText(`![A ${gesture} image](images/${gesture}.png)`, { timeout: 15_000 })
  await page.getByRole("button", { name: "Rendered", exact: true }).click()
  await expect(frame(page).getByRole("button", { name: `View image: A ${gesture} image`, exact: true }).locator("img")).toBeVisible()
})
