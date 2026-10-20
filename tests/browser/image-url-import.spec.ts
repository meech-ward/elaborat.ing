import { expect, test, type Page } from "./fixtures.ts"
import { fakeSupabase, person, signedIn, SUPABASE } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"
import { showView } from "./views.ts"
import { imageDigest, imageObjectKeys } from "../../src/features/images/types.ts"

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64")
const publicURL = "https://images.example.test/remote-pixel.png"
const note = "Anchor paragraph.\n\nAfter paragraph.\n"
const preview = (page: Page) => page.frameLocator('iframe[title="Isolated document preview"]:visible')
const source = (page: Page) => page.locator(".monaco-editor:visible .view-lines").first()
test.use({ viewport: { width: 1280, height: 900 } })
test.describe.configure({ timeout: 60_000 })

async function setup(page: Page, delayed = false) {
  const fake = await fakeSupabase(page)
  const remote = fake.server.remote(person.id)
  const id = crypto.randomUUID()
  await remote.createProject(id, "URL image import")
  await remote.saveFiles(id, crypto.randomUUID(), [{ op: "put", path: "note.mdx", content: note }])
  const imported: Array<{ url: string; asset_id: string }> = []
  const external: string[] = []
  page.on("request", request => { if (new URL(request.url()).origin === new URL(publicURL).origin) external.push(request.url()) })
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let finished = false
  await page.route(url => url.origin === SUPABASE && url.pathname === "/functions/v1/images" && url.searchParams.get("import") === "1", async route => {
    if (route.request().method() !== "POST") return route.fallback()
    const body = route.request().postDataJSON() as { url: string; asset_id: string }
    imported.push(body)
    expect(body.url).toBe(publicURL)
    expect(route.request().headers()["authorization"]).toMatch(/^Bearer /)
    if (delayed) await gate
    try {
      const bytes = new Blob([new Uint8Array(png)], { type: "image/png" })
      const asset = await remote.uploadImage!(id, { id: body.asset_id, ...imageObjectKeys(id, body.asset_id), media_type: "image/png", width: 1, height: 1, byte_length: png.length, sha256: await imageDigest(new Uint8Array(png)), preview_type: "image/png", preview_byte_length: png.length }, bytes)
      await route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*" }, contentType: "application/json", body: JSON.stringify({ asset }) })
    } finally { finished = true }
  })
  await signedIn(page)
  await page.goto(new URL(`projects/${id}/note.mdx`, APP_URL).href)
  await showView(page, "Rendered")
  await expect(preview(page).getByText("Anchor paragraph.", { exact: true })).toBeVisible()
  await preview(page).getByText("Anchor paragraph.", { exact: true }).click({ button: "right" })
  await preview(page).getByRole("menuitem", { name: "Image", exact: true }).click()
  const picker = page.getByRole("dialog", { name: "Insert image", exact: true })
  await picker.getByLabel("Import from URL", { exact: true }).fill(publicURL)
  return { fake, id, imported, external, picker, release, finished: () => finished }
}

test("explicit URL import saves a project copy and reloads offline without contacting the image host", async ({ page }) => {
  const { fake, id, imported, external, picker } = await setup(page)
  expect(imported).toEqual([])
  expect(external).toEqual([])
  await picker.getByRole("button", { name: "Import", exact: true }).click()
  await expect(picker.getByLabel("Image description", { exact: true })).toBeEnabled()
  await picker.getByLabel("Image description", { exact: true }).fill("An imported red pixel")
  await picker.getByRole("button", { name: "Insert image", exact: true }).click()
  const image = preview(page).getByRole("img", { name: "An imported red pixel", exact: true })
  await expect(image).toBeVisible()
  await expect(image).toHaveAttribute("src", /^data:image\//)
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect.poll(() => fake.server.content(id, "note.mdx")).toContain("![An imported red pixel](images/remote-pixel.png)")
  await expect(page.getByRole("status").filter({ hasText: "Synced" })).toBeVisible()
  const asset = fake.server.projects.get(id)!.files.get("images/remote-pixel.png")!
  expect(asset.kind).toBe("image")
  expect(asset.content).toBe("")
  expect(asset.asset?.sha256).toBe(await imageDigest(new Uint8Array(png)))
  fake.offline = true
  await page.reload()
  await expect(image).toBeVisible({ timeout: 15_000 })
  await showView(page, "Source")
  await expect(source(page)).toContainText("![An imported red pixel](images/remote-pixel.png)")
  await expect(source(page)).not.toContainText(publicURL)
  await expect(source(page)).not.toContainText("data:image")
  expect(imported).toHaveLength(1)
  expect(external).toEqual([])
})

test("cancelling an in-flight URL import preserves the note after the response arrives", async ({ page }) => {
  const { fake, id, imported, external, picker, release, finished } = await setup(page, true)
  await picker.getByRole("button", { name: "Import", exact: true }).click()
  await expect.poll(() => imported.length).toBe(1)
  await picker.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(picker).toBeHidden()
  release()
  await expect.poll(finished).toBe(true)
  await expect(preview(page).locator("img")).toHaveCount(0)
  await showView(page, "Source")
  await expect(source(page)).toContainText("Anchor paragraph.")
  await expect(source(page)).toContainText("After paragraph.")
  await expect(source(page)).not.toContainText("![")
  expect(fake.server.content(id, "note.mdx")).toBe(note)
  expect(external).toEqual([])
})
