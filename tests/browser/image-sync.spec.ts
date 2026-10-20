import { expect, test } from "./fixtures.ts"
import { fakeSupabase, person, signedIn } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"
import { showView } from "./views.ts"

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64")
test.use({ viewport: { width: 1280, height: 900 } })
test.describe.configure({ timeout: 60_000 })

test("signed-in image Save uploads binary bytes and a fresh device downloads private originals and previews", async ({ page, browser }) => {
  const fake = await fakeSupabase(page)
  const remote = fake.server.remote(person.id)
  const id = crypto.randomUUID()
  await remote.createProject(id, "Image sync")
  await remote.saveFiles(id, crypto.randomUUID(), [{ op: "put", path: "note.mdx", content: "Anchor paragraph.\n\nAfter paragraph.\n" }])
  await signedIn(page)
  const url = new URL(`projects/${id}/note.mdx`, APP_URL).href
  await page.goto(url)
  await showView(page, "Rendered")
  const frame = page.frameLocator('iframe[title="Isolated document preview"]:visible')
  await frame.getByText("Anchor paragraph.", { exact: true }).click({ button: "right" })
  await frame.getByRole("menuitem", { name: "Image", exact: true }).click()
  const picker = page.getByRole("dialog", { name: "Insert image", exact: true })
  await picker.getByLabel("Upload images", { exact: true }).setInputFiles({ name: "private.png", mimeType: "image/png", buffer: png })
  await expect(picker.getByLabel("Image description", { exact: true })).toBeEnabled()
  await picker.getByLabel("Image description", { exact: true }).fill("A synced red pixel")
  await picker.getByRole("button", { name: "Insert image", exact: true }).click()
  await expect(frame.getByRole("img", { name: "A synced red pixel", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect(page.getByRole("tab", { name: "note.mdx", exact: true })).toBeVisible()
  await expect.poll(() => fake.server.content(id, "note.mdx")).toContain("![A synced red pixel](images/private.png)")
  const upload = fake.requests.find(request => new URL(request.url()).pathname === "/functions/v1/images")!
  expect(upload.postDataBuffer()).toEqual(png)
  expect(upload.headers()["authorization"]).toMatch(/^Bearer /)
  const savedImage = fake.server.projects.get(id)!.files.get("images/private.png")!
  expect(savedImage.content).toBe("")
  expect(savedImage.asset?.byte_length).toBe(png.length)
  const fresh = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" })
  try {
    const second = await fresh.newPage()
    const errors: string[] = []
    second.on("pageerror", error => {
      // Playwright's service-worker blocker also runs in the sandboxed frame.
      if (error.message.startsWith("Failed to read the 'serviceWorker' property")) return
      errors.push(error.message)
    })
    const downloads = await fakeSupabase(second, { server: fake.server })
    await signedIn(second)
    await second.goto(url)
    await showView(second, "Rendered")
    await expect(second.frameLocator('iframe[title="Isolated document preview"]:visible').getByRole("img", { name: "A synced red pixel", exact: true })).toBeVisible({ timeout: 15_000 })
    const requests = downloads.requests.filter(request => new URL(request.url()).pathname.includes(`/project-images/${id}/${savedImage.asset!.id}/`))
    expect(requests.some(request => request.url().endsWith("/original"))).toBe(true)
    expect(requests.some(request => request.url().endsWith("/preview"))).toBe(true)
    expect(requests.every(request => /^Bearer /.test(request.headers()["authorization"] ?? ""))).toBe(true)
    expect(errors).toEqual([])
  } finally { await fresh.close() }
})
