import { readdirSync, readFileSync } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import path from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { fakeSupabase, person, signedIn } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

// The app starts again with no network once a project has opened on the
// device: its service worker caches the whole build. The rest of the suite
// blocks service workers (playwright.config.ts); this spec allows them.

test.use({ serviceWorkers: "allow" })
// Each journey installs the worker, which caches about 30 MB of app files.
test.describe.configure({ timeout: 90_000 })

const DIST = path.join(import.meta.dirname, "..", "..", "dist")
const NEXT = path.join(import.meta.dirname, "..", "..", "dist-next")

const projectUrl = (id: string, file?: string) => new URL(`projects/${id}${file ? `/${file}` : ""}`, APP_URL).href
const editorText = (page: Page) => page.locator(".monaco-editor:visible .view-lines").first()
const unsaved = (page: Page, file: string) => page.getByRole("tab", { name: file }).getByLabel("unsaved changes")

/** The files a build's service worker caches, read from its generated sw.js. */
function precached(dist: string): Set<string> {
  const worker = readFileSync(path.join(dist, "sw.js"), "utf8")
  return new Set([...worker.matchAll(/\{url:"([^"]+)",revision:(?:"[^"]*"|null)\}/g)].map((match) => match[1]))
}

/** Every file a build ships, as paths relative to it. */
function shipped(dist: string): string[] {
  return readdirSync(dist, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dist, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
}

async function openProject(page: Page, files: Record<string, string>, file: string) {
  const fake = await fakeSupabase(page)
  const id = crypto.randomUUID()
  const remote = fake.server.remote(person.id)
  await remote.createProject(id, "Notes")
  await remote.saveFiles(id, crypto.randomUUID(), Object.entries(files).map(([path, content]) => ({ op: "put" as const, path, content })))
  await signedIn(page)
  await page.goto(projectUrl(id, file))
  await expect(page.getByRole("status").filter({ hasText: "Synced" })).toBeVisible({ timeout: 15_000 })
  return { fake, id }
}

/** Wait until the app's first version has cached the build and controls the page. */
async function offlineReady(page: Page) {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready
    if (!navigator.serviceWorker.controller) {
      await new Promise((resolve) => navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true }))
    }
  })
}

/** Every URL in the page's Cache Storage. */
const cachedUrls = (page: Page) =>
  page.evaluate(async () => {
    const urls: string[] = []
    for (const name of await caches.keys()) {
      for (const request of await (await caches.open(name)).keys()) urls.push(request.url)
    }
    return urls
  })

test("the service worker caches every file the build ships", () => {
  const list = precached(DIST)
  const files = shipped(DIST).filter((file) => file !== "_headers" && file !== "sw.js" && !/^workbox-[\w-]+\.js$/.test(file))
  expect(files.length).toBeGreaterThan(100)
  expect(files.filter((file) => !list.has(file))).toEqual([])
})

test("the license notices cover the Workbox code the service worker ships", () => {
  // sw.js loads its Workbox runtime from a file of its own, outside the bundle.
  const runtime = /define\(\["\.\/(workbox-[\w-]+)"\]/.exec(readFileSync(path.join(DIST, "sw.js"), "utf8"))?.[1]
  expect(runtime).toBeDefined()
  const code = readFileSync(path.join(DIST, `${runtime}.js`), "utf8")
  const modules = new Set([...code.matchAll(/workbox:([a-z-]+):\d/g)].map((match) => `workbox-${match[1]}`))
  const notices = readFileSync(path.join(DIST, "third-party-notices.txt"), "utf8")
  expect(modules.size).toBeGreaterThan(0)
  expect([...modules].filter((name) => !notices.includes(`\n## ${name} - `))).toEqual([])
})

test("after a project has opened, loading it again with no network brings back the app, the project and an unsaved edit", async ({ page, context }) => {
  const { fake } = await openProject(page, { "notes/a.md": "saved\n" }, "notes/a.md")
  await offlineReady(page)
  await editorText(page).click()
  await page.keyboard.press("ControlOrMeta+End")
  await page.keyboard.type("draft")
  await expect(unsaved(page, "notes/a.md")).toBeVisible()
  // Let the draft reach the device's storage.
  await page.waitForTimeout(300)

  fake.offline = true
  await context.setOffline(true)
  // Load the same address again. In Firefox, Playwright's page.reload() fails
  // offline (NS_ERROR_OFFLINE), while a navigation is answered by the worker.
  await page.goto(page.url())
  await expect(page.getByRole("heading", { level: 1, name: "Notes" })).toBeVisible()
  await expect(unsaved(page, "notes/a.md")).toBeVisible()
  await expect(editorText(page)).toContainText("saveddraft")
})

test("offline, a new tab lists the project from the device and opens it", async ({ page, context }) => {
  const { fake } = await openProject(page, { "notes/a.md": "On this device.\n" }, "notes/a.md")
  await offlineReady(page)
  fake.offline = true
  await context.setOffline(true)

  const other = await context.newPage()
  await other.goto(APP_URL)
  await expect(other.getByRole("heading", { name: "Your projects" })).toBeVisible()
  await expect(other.getByText("Offline: showing the projects on this device.")).toBeVisible()
  await other.getByRole("link", { name: "Notes" }).click()
  await expect(other.getByRole("tab", { name: "notes/a.md" })).toBeVisible()
  await expect(editorText(other)).toContainText("On this device.")
})

test("nothing from Supabase, or from any other origin, is kept in Cache Storage", async ({ page }) => {
  const { fake } = await openProject(page, { "a.md": "text\n" }, "a.md")
  await offlineReady(page)
  // Once the worker controls the page, its requests to Supabase still go
  // straight to the network (here, the stand-in), and none is cached.
  const before = fake.requests.length
  await page.reload()
  await expect(page.getByRole("status").filter({ hasText: "Synced" })).toBeVisible({ timeout: 15_000 })
  expect(fake.requests.length).toBeGreaterThan(before)
  const urls = await cachedUrls(page)
  expect(urls.length).toBeGreaterThanOrEqual(precached(DIST).size)
  expect(urls.filter((url) => !url.startsWith(APP_URL))).toEqual([])
})

/**
 * Serves a build the way the host does: its files, and index.html for any
 * other navigation. Changing `site.root` deploys another build.
 */
async function serveBuild(root: string) {
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".webmanifest": "application/manifest+json",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".ttf": "font/ttf",
    ".wasm": "application/wasm",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
  }
  const site = { root }
  const server = createServer((request, response) => {
    void (async () => {
      const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname)
      let file = path.join(site.root, pathname)
      const found = file.startsWith(site.root + path.sep) && (await stat(file).catch(() => null))?.isFile()
      if (!found) {
        if (request.headers["sec-fetch-mode"] !== "navigate") {
          response.writeHead(404).end()
          return
        }
        file = path.join(site.root, "index.html")
      }
      response.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" })
      response.end(await readFile(file))
    })()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return { site, url: `http://127.0.0.1:${port}/`, close: () => new Promise((resolve) => server.close(resolve)) }
}

test("a new version waits until the person chooses Update ready, then runs", async ({ page, context }) => {
  const host = await serveBuild(DIST)
  const stayed = (tab: Page) => tab.evaluate(() => (window as { stayed?: boolean }).stayed === true)
  const stay = (tab: Page) => tab.evaluate(() => void ((window as { stayed?: boolean }).stayed = true))
  try {
    const fake = await fakeSupabase(page)
    await signedIn(page)
    await page.goto(host.url)
    const heading = page.getByRole("heading", { name: /^Your projects/ })
    await expect(heading).toHaveText("Your projects")
    await offlineReady(page)

    // The next version is deployed. A file only the running version uses is
    // no longer on the host, but the running version's cache still has it.
    const next = precached(NEXT)
    const retired = new URL([...precached(DIST)].find((file) => file.endsWith(".js") && !next.has(file))!, host.url).href
    host.site.root = NEXT
    await page.reload()
    const update = page.getByRole("button", { name: "Update ready" })
    await expect(update).toBeVisible({ timeout: 30_000 })

    // Until it is chosen, the running version keeps working, reloads
    // included, and nothing reloads by itself.
    await expect(heading).toHaveText("Your projects")
    await page.reload()
    await expect(heading).toHaveText("Your projects")
    await expect(update).toBeVisible()
    expect(await cachedUrls(page)).toContain(retired)
    await stay(page)
    await page.waitForTimeout(2_000)
    expect(await stayed(page)).toBe(true)

    // A second tab offers the update too.
    const other = await context.newPage()
    await fakeSupabase(other, { server: fake.server })
    await other.goto(host.url)
    const otherHeading = other.getByRole("heading", { name: /^Your projects/ })
    await expect(otherHeading).toHaveText("Your projects")
    await expect(other.getByRole("button", { name: "Update ready" })).toBeVisible()
    await stay(other)

    // Choosing it reloads this tab into the new version.
    await update.click()
    await expect(heading).toHaveText("Your projects, updated")
    await expect(update).toBeHidden()
    // The old version's files leave the cache once the new version runs.
    await expect.poll(() => cachedUrls(page)).not.toContain(retired)

    // The other tab keeps running until the person chooses the update there.
    await page.waitForTimeout(1_000)
    expect(await stayed(other)).toBe(true)
    await expect(otherHeading).toHaveText("Your projects")
    await other.getByRole("button", { name: "Update ready" }).click()
    await expect(otherHeading).toHaveText("Your projects, updated")
  } finally {
    await host.close()
  }
})
