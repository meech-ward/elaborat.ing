import { expect, test } from "./fixtures.ts"
import { fakeSupabase } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

// A viewBox-only SVG has browser-default intrinsic dimensions. Cropping
// must use the validated project dimensions, with the full vector rasterized.
test.use({ viewport: { width: 1280, height: 900 } })
test.describe.configure({ timeout: 60_000 })
test("cropping a viewBox-only SVG selects the intended source pixels", async ({ page }) => {
  await fakeSupabase(page)
  await page.goto(APP_URL)
  await page.getByRole("banner").getByRole("link", { name: "Start writing" }).click()
  await page.getByRole("button", { name: "New file", exact: true }).click()
  await page.getByRole("menuitem", { name: "New note", exact: true }).click()
  await page.getByRole("textbox", { name: /^Name of the new note in / }).fill("crop.mdx")
  await page.keyboard.press("Enter")
  const source = page.locator(".monaco-editor:visible .view-lines").first()
  await expect(source).toBeVisible()
  await source.click()
  await page.keyboard.type("Anchor paragraph.\n")
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect(page.getByRole("tab", { name: "crop.mdx", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Rendered", exact: true }).click()
  const frame = page.frameLocator('iframe[title="Isolated document preview"]:visible')
  await frame.getByText("Anchor paragraph.", { exact: true }).click({ button: "right" })
  await frame.getByRole("menuitem", { name: "Image", exact: true }).click()
  const picker = page.getByRole("dialog", { name: "Insert image", exact: true })
  await picker.getByLabel("Upload images", { exact: true }).setInputFiles({ name: "split.svg", mimeType: "image/svg+xml", buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><rect width="100" height="50" fill="red"/><rect x="50" width="50" height="50" fill="blue"/></svg>') })
  await expect(picker.getByLabel("Image description", { exact: true })).toBeEnabled()
  await picker.getByText("Resize or crop a copy", { exact: true }).click()
  await picker.getByLabel("Crop left", { exact: true }).fill("50")
  await picker.getByLabel("Crop width", { exact: true }).fill("50")
  await picker.getByRole("button", { name: "Apply resize and crop", exact: true }).click()
  await expect(picker.getByText(/split-edited\.png/)).toBeVisible()
  await picker.getByLabel("Image description", { exact: true }).fill("The blue half")
  await picker.getByRole("button", { name: "Insert image", exact: true }).click()
  const image = frame.getByRole("button", { name: "View image: The blue half", exact: true }).locator("img")
  await expect(image).toBeVisible()
  const pixel = await image.evaluate(async element => {
    await (element as HTMLImageElement).decode()
    const canvas = document.createElement("canvas")
    canvas.width = canvas.height = 1
    const context = canvas.getContext("2d")!
    context.drawImage(element as HTMLImageElement, 0, 0, 1, 1)
    return [...context.getImageData(0, 0, 1, 1).data]
  })
  expect(pixel[0]).toBeLessThan(40)
  expect(pixel[2]).toBeGreaterThan(220)
  expect(pixel[3]).toBe(255)
})
