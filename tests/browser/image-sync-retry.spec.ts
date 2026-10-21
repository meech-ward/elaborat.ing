import { expect, test } from "./fixtures.ts"
import { fakeSupabase, person, signedIn } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"
import { showView } from "./views.ts"

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64")
test.use({ viewport: { width: 1280, height: 900 } })
test.describe.configure({ timeout: 60_000 })

test("Sync now retries a stopped image upload while automatic reopen preserves the stop and local pixels", async ({ page, appErrors }) => {
  appErrors.expect("The server refused these changes")
  appErrors.expect("Not synced")
  const fake = await fakeSupabase(page)
  const remote = fake.server.remote(person.id)
  const id = crypto.randomUUID()
  await remote.createProject(id, "Retry images")
  await remote.saveFiles(id, crypto.randomUUID(), [{ op: "put", path: "note.mdx", content: "Anchor paragraph.\n" }])
  let broken = true, uploads = 0
  const retryRelease = Promise.withResolvers<void>()
  await page.route("**/functions/v1/images?*", async route => {
    if (route.request().method() !== "POST") return route.fallback()
    uploads++
    if (!broken) {
      await retryRelease.promise
      return route.fallback()
    }
    return route.fulfill({ status: 500, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*" }, contentType: "application/json", body: JSON.stringify({ error: "The image thumbnail service is temporarily unavailable." }) })
  })
  await signedIn(page)
  await page.goto(new URL(`projects/${id}/note.mdx`, APP_URL).href)
  await showView(page, "Rendered")
  const frame = page.frameLocator('iframe[title="Isolated document preview"]:visible')
  await frame.getByText("Anchor paragraph.", { exact: true }).click({ button: "right" })
  await frame.getByRole("menuitem", { name: "Image", exact: true }).click()
  const picker = page.getByRole("dialog", { name: "Insert image", exact: true })
  await picker.getByLabel("Upload images", { exact: true }).setInputFiles({ name: "retry.png", mimeType: "image/png", buffer: png })
  await expect(picker.getByLabel("Image description", { exact: true })).toBeEnabled()
  await picker.getByLabel("Image description", { exact: true }).fill("A recoverable red pixel")
  await picker.getByRole("button", { name: "Insert image", exact: true }).click()
  const image = frame.getByRole("button", { name: "View image: A recoverable red pixel", exact: true }).locator("img")
  await expect(image).toBeVisible()
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect(page.getByRole("alert").filter({ hasText: "The server refused these changes" })).toBeVisible()
  await expect(page.getByRole("alert").filter({ hasText: "The server refused these changes" })).toContainText("The image thumbnail service is temporarily unavailable.")
  expect(uploads).toBe(1)
  expect(fake.server.content(id, "note.mdx")).toBe("Anchor paragraph.\n")
  broken = false
  await page.reload()
  await expect(page.getByRole("alert").filter({ hasText: "The server refused these changes" })).toBeVisible()
  await expect(page.getByRole("alert").filter({ hasText: "The server refused these changes" })).toContainText("The image thumbnail service is temporarily unavailable.")
  await expect(image).toBeVisible()
  expect(uploads).toBe(1)
  await page.getByRole("button", { name: "Account and settings", exact: true }).click()
  try {
    await page.getByRole("menuitem", { name: "Sync now", exact: true }).click()
    await expect(page.getByRole("status", { name: "Syncing changes with the server", exact: true })).toBeVisible()
    await expect(page.getByRole("alert").filter({ hasText: "The server refused these changes" })).toHaveCount(0)
    await expect(image).toBeVisible()
    await page.getByRole("button", { name: "Account and settings", exact: true }).click()
    await expect(page.getByRole("menuitem", { name: "Sync now", exact: true })).toBeDisabled()
    await page.keyboard.press("Escape")
  } finally {
    retryRelease.resolve()
  }
  await expect.poll(() => fake.server.content(id, "note.mdx")).toContain("![A recoverable red pixel](images/retry.png)")
  expect(uploads).toBe(2)
  await expect(page.getByRole("status").filter({ hasText: "Synced" })).toBeVisible()
  await expect(page.getByRole("alert").filter({ hasText: "The server refused these changes" })).toHaveCount(0)
  await expect(image).toBeVisible()
  await page.getByRole("button", { name: "Account and settings", exact: true }).click()
  await expect(page.getByRole("menuitem", { name: "Sync now", exact: true })).toBeEnabled()
})
