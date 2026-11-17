import AxeBuilder from "./axe.ts"
import { expect, test, type Locator, type Page } from "./fixtures.ts"
import { FakeProjectServer } from "../../src/features/project-storage/fakeServer.ts"
import { fakeSupabase, person, signedIn, type FakeSupabase } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

test.describe.configure({ timeout: 60_000 })

const OTHER = "5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f"
const PATH = "notes/plan.md"
const TEXTS = ["# Plan\n\nFirst save.\n", "# Plan\n\nBefore midnight.\n", "# Plan\n\nIntermediate save.\n", "# Plan\n\nLast save of the day.\n"]
const TIMES = ["2026-11-10T12:00:00.000Z", "2026-11-11T23:59:00.000Z", "2026-11-12T00:01:00.000Z", "2026-11-12T23:59:00.000Z"]
const projectUrl = (id: string) => new URL(`projects/${id}/${PATH}`, APP_URL).href
const history = (page: Page) => page.getByRole("dialog", { name: "Version history", exact: true })
const saves = (fake: FakeSupabase) => fake.requests.filter(request => request.url().endsWith("/rpc/save_files"))

type Version = {
  file_id: string
  project_id: string
  version: number
  path: string
  kind: "text"
  asset: null
  deleted: boolean
  content: string
  author_id: string
  created_at: string
}

/** Native details expose both the day and each original save without hiding versions behind a summary. */
const day = (dialog: Locator, date: string) => dialog.locator("summary").filter({ hasText: new RegExp(`^${date}`) }).locator("..")
const version = (dialog: Locator, at: number) => dialog.locator("summary").filter({ hasText: new RegExp(`^Version ${at}\\b`) }).locator("..")

async function expand(details: Locator) {
  if (await details.getAttribute("open") === null) await details.locator(":scope > summary").click()
}

async function openProject(page: Page, viewer = false) {
  const server = new FakeProjectServer()
  const ownerId = viewer ? OTHER : person.id
  const remote = server.remote(ownerId)
  const id = crypto.randomUUID()
  await remote.createProject(id, "History")
  for (const content of TEXTS) {
    const before = server.projects.get(id)!.files.get(PATH)
    await remote.saveFiles(id, crypto.randomUUID(), [{ op: "put", path: PATH, content, ...(before ? { base_version: before.version } : {}) }])
  }
  const fileId = server.projects.get(id)!.files.get(PATH)!.id
  const collaborator = viewer ? person.id : OTHER
  server.share(id, collaborator, viewer ? "viewer" : "editor")
  server.names.set(ownerId, "Ada")
  server.names.set(collaborator, "Grace")
  const rows: Version[] = TEXTS.map((content, index) => ({
    file_id: fileId, project_id: id, version: index + 1, path: PATH, kind: "text", asset: null, deleted: false,
    content, author_id: index === 2 ? collaborator : ownerId, created_at: TIMES[index],
  }))
  const original = structuredClone(rows)
  const fake = await fakeSupabase(page, { server })
  const reads: URL[] = []
  // The regular fake serves synchronization's tombstones. Only the history
  // reads for this file use these complete, immutable historical records.
  await page.route("**/rest/v1/file_versions?**", async route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get("file_id") !== `eq.${fileId}`) return route.fallback()
    if (fake.offline) return route.abort("internetdisconnected")
    reads.push(url)
    const current = server.projects.get(id)!.files.get(PATH)
    if (current && current.version > 4 && !rows.some(row => row.version === current.version)) {
      rows.push({ ...rows[3], version: current.version, content: current.content, created_at: "2026-11-13T12:00:00.000Z", author_id: ownerId })
    }
    const condition = url.searchParams.get("version")
    const before = url.searchParams.get("created_at")?.slice(3)
    const cursor = /created_at\.lt\.([^,]+),and\(created_at\.eq\.([^,]+),version\.lt\.(\d+)\)/.exec(url.searchParams.get("or") ?? "")
    const selected = rows.filter(row => (!condition || (condition.startsWith("eq.") ? row.version === Number(condition.slice(3)) : row.version < Number(condition.slice(3))))
      && (!before || Date.parse(row.created_at) < Date.parse(before))
      && (!cursor || Date.parse(row.created_at) < Date.parse(cursor[1]) || (Date.parse(row.created_at) === Date.parse(cursor[2]) && row.version < Number(cursor[3]))))
      .sort((a, b) => url.searchParams.get("order")?.startsWith("created_at") ? Date.parse(b.created_at) - Date.parse(a.created_at) || b.version - a.version : b.version - a.version)
      .slice(0, Number(url.searchParams.get("limit") ?? 100))
    const fields = url.searchParams.get("select")?.split(",") ?? []
    const response = selected.map(row => fields.includes("*") ? row : Object.fromEntries(fields.map(field => [field, row[field as keyof Version]])))
    const single = route.request().headers().accept?.includes("application/vnd.pgrst.object+json")
    return route.fulfill({
      status: 200, headers: { "access-control-allow-origin": "*", "access-control-expose-headers": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" },
      contentType: "application/json", body: JSON.stringify(single ? response[0] ?? null : response),
    })
  })
  await signedIn(page)
  await page.goto(projectUrl(id))
  await expect(page.getByRole("button", { name: "File actions", exact: true })).toBeVisible({ timeout: 15_000 })
  return { fake, id, fileId, rows, original, reads, revision: server.projects.get(id)!.revision }
}

async function openHistory(page: Page) {
  await page.getByRole("button", { name: "File actions", exact: true }).click()
  await page.getByRole("menuitem", { name: "Version history", exact: true }).click()
  await expect(history(page)).toBeVisible()
  await expect(day(history(page), "November 12, 2026")).toBeVisible()
  return history(page)
}

test("UTC days show a combined diff and expand every save with its author and time", async ({ page }) => {
  const { reads, rows, original } = await openProject(page)
  const dialog = await openHistory(page)
  await expect(dialog).toContainText("UTC")
  const latest = day(dialog, "November 12, 2026")
  await expect(latest.locator(":scope > summary")).toContainText("2 saves")
  await expect(latest).toHaveAttribute("open", "")
  // The first save of the day is not its baseline: compare the previous
  // day's final save directly with this day's final save.
  await expect(latest.locator(".editor.original").first()).toContainText("Before midnight.")
  await expect(latest.locator(".editor.modified").first()).toContainText("Last save of the day.")
  await expect(latest.locator(".editor.modified").first()).not.toContainText("Intermediate save.")
  await expand(version(dialog, 3))
  await expect(version(dialog, 3)).toContainText("Grace")
  await expect(version(dialog, 3).locator("time")).toHaveAttribute("datetime", TIMES[2])
  await expect(version(dialog, 3)).toContainText("12:01:00 AM UTC")
  await expect(version(dialog, 3).locator(".editor.modified")).toContainText("Intermediate save.")
  await expand(day(dialog, "November 11, 2026"))
  await expand(version(dialog, 2))
  await expect(version(dialog, 2)).toContainText("Ada")
  await expect(version(dialog, 2).locator("time")).toHaveAttribute("datetime", TIMES[1])
  await expand(day(dialog, "November 10, 2026"))
  await expect(dialog.locator("summary").filter({ hasText: /^Version \d+\b/ })).toHaveCount(4)
  expect(rows).toEqual(original)
  // Listing history never fetches all contents. Content reads select one version.
  for (const read of reads.filter(read => read.searchParams.get("select")?.split(",").includes("content"))) {
    expect(read.searchParams.get("version")).toMatch(/^eq\.\d+$/)
  }
  const axe = await new AxeBuilder({ page }).include('[role="dialog"]').analyze()
  expect(axe.violations.map(violation => ({ id: violation.id, targets: violation.nodes.map(node => node.target) }))).toEqual([])
  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden()
  await expect(page.getByRole("button", { name: "File actions", exact: true })).toBeFocused()
})

test("restoring an individual save creates a new revision-checked save and keeps the originals", async ({ page }) => {
  const { fake, id, rows, original, revision } = await openProject(page)
  const dialog = await openHistory(page)
  await expand(version(dialog, 3))
  await version(dialog, 3).getByRole("button", { name: "Restore version 3", exact: true }).click()
  await expect.poll(() => fake.server.content(id, PATH)).toBe(TEXTS[2])
  expect(saves(fake).at(-1)!.postDataJSON().changes).toEqual([{ op: "put", path: PATH, content: TEXTS[2], base_version: 4 }])
  expect(fake.server.projects.get(id)!.files.get(PATH)!.version).toBe(revision + 1)
  expect(fake.server.projects.get(id)!.history.map(row => row.version)).toEqual([1, 2, 3, 4, revision + 1])
  expect(rows.filter(row => row.version <= 4)).toEqual(original)
})

test("an unsaved draft blocks restore and keeps the draft", async ({ page }) => {
  const { fake } = await openProject(page)
  await page.locator(".monaco-editor:visible .view-lines").first().click()
  await page.keyboard.type("Unsaved local text")
  await expect(page.getByRole("tab", { name: `${PATH}, unsaved changes` })).toBeVisible()
  const dialog = await openHistory(page)
  await expand(version(dialog, 3))
  await expect(version(dialog, 3).getByRole("button", { name: "Restore version 3", exact: true })).toBeDisabled()
  expect(saves(fake)).toHaveLength(0)
  await page.keyboard.press("Escape")
  await expect(page.locator(".monaco-editor:visible .view-lines").first()).toContainText("Unsaved local text")
})

test("a server edit after history opens conflicts instead of being overwritten by restore", async ({ page, appErrors }) => {
  appErrors.expect("was changed on another device too, so its sync stopped.")
  appErrors.expect("Changed in two places: choose which version to keep")
  const { fake, id, revision } = await openProject(page)
  const dialog = await openHistory(page)
  await expand(version(dialog, 3))
  const newer = "# Plan\n\nSaved on another device.\n"
  await fake.server.remote(person.id).saveFiles(id, crypto.randomUUID(), [{ op: "put", path: PATH, content: newer, base_version: 4 }])
  // No Broadcast signal: this device still believes version 4 is current.
  await version(dialog, 3).getByRole("button", { name: "Restore version 3", exact: true }).click()
  await expect.poll(() => saves(fake).length).toBe(1)
  expect(saves(fake)[0].postDataJSON().changes).toEqual([{ op: "put", path: PATH, content: TEXTS[2], base_version: 4 }])
  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden()
  await expect(page.getByRole("alert").filter({ hasText: "was changed on another device too" })).toBeVisible({ timeout: 15_000 })
  expect(fake.server.content(id, PATH)).toBe(newer)
  expect(fake.server.projects.get(id)!.files.get(PATH)!.version).toBe(revision + 1)
})

test("a viewer can read history but cannot restore a save", async ({ page }) => {
  const { fake } = await openProject(page, true)
  const dialog = await openHistory(page)
  await expand(version(dialog, 3))
  await expect(version(dialog, 3).getByRole("button", { name: "Restore version 3", exact: true })).toHaveCount(0)
  await expect(version(dialog, 3).locator(".editor.modified")).toContainText("Intermediate save.")
  expect(saves(fake)).toHaveLength(0)
})

test("history explains a missing connection and retries without changing the file", async ({ page, appErrors }) => {
  appErrors.expect("Version history needs a connection and project access.")
  const { fake, id } = await openProject(page)
  fake.offline = true
  await page.getByRole("button", { name: "File actions", exact: true }).click()
  await page.getByRole("menuitem", { name: "Version history", exact: true }).click()
  const dialog = history(page)
  await expect(dialog.getByRole("alert")).toContainText("Version history needs a connection and project access.")
  fake.offline = false
  await dialog.getByRole("button", { name: "Try again", exact: true }).click()
  await expect(day(dialog, "November 12, 2026").locator(".editor.modified")).toContainText("Last save of the day.")
  expect(saves(fake)).toHaveLength(0)
  expect(fake.server.content(id, PATH)).toBe(TEXTS[3])
})

test("closing a comparison before its worker is ready cancels it and history reopens", async ({ page }) => {
  let release!: () => void
  const ready = new Promise<void>(resolve => { release = resolve })
  let workers = 0
  await page.route(/\/assets\/editor\.worker-[^/]+\.js$/, async route => {
    workers++
    await ready
    await route.continue()
  })
  try {
    await openProject(page)
    let dialog = await openHistory(page)
    await expand(version(dialog, 3))
    await expect(version(dialog, 3).locator(".editor.modified")).toContainText("Intermediate save.")
    await expect.poll(() => workers).toBeGreaterThan(0)
    await page.keyboard.press("Escape")
    await expect(dialog).toBeHidden()
    release()
    dialog = await openHistory(page)
    await expect(day(dialog, "November 12, 2026").locator(".line-insert").first()).toBeVisible()
  } finally { release() }
})

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test("File actions opens readable history within the viewport", async ({ page }) => {
    await openProject(page)
    const dialog = await openHistory(page)
    await expand(version(dialog, 3))
    await expect(version(dialog, 3).getByRole("button", { name: "Restore version 3", exact: true })).toBeVisible()
    const box = await dialog.boundingBox()
    expect(box && box.x >= 0 && box.x + box.width <= 390 && box.y >= 0 && box.y + box.height <= 845).toBe(true)
    const axe = await new AxeBuilder({ page }).include('[role="dialog"]').analyze()
    expect(axe.violations.map(violation => ({ id: violation.id, targets: violation.nodes.map(node => node.target) }))).toEqual([])
  })
})
