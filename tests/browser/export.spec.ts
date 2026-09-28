import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { expect, test, type Download, type Page } from "@playwright/test"
import { unzipSync } from "fflate"
import { FakeProjectServer } from "../../src/features/project-storage/fakeServer.ts"
import { fakeSupabase, person, signedIn, type FakeSupabase } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

// Downloading a project as a .zip, built on the device from its copy there,
// and importing a .zip or a folder as a new project, against the stand-in
// Supabase. A downloaded project imports back byte for byte.

test.describe.configure({ timeout: 60_000 })

const projectUrl = (id: string) => new URL(`projects/${id}`, APP_URL).href

// Every kind of file, with bytes that are easy to lose: a byte order mark, CRLF, a tab and an emoji.
const files: Record<string, string> = {
  "notes/intro.mdx": '﻿import { Badge } from "workspace:components/badge.mdx"\r\n\r\n# Intro\t🙂 <Badge />\r\n',
  "components/badge.mdx": 'export const Badge = () => <span className="badge">new</span>\n',
  "drawings/sketch.excalidraw": '{"type":"excalidraw","version":2,"elements":[],"appState":{},"files":{}}',
  "diagrams/flow.d2": "idea -> draft -> done\n",
  "diagrams/flow.excalidraw": '{"type":"excalidraw","version":2,"elements":[]}',
  "diagrams/flow.d2.json": '{"version":1,"source":"diagrams/flow.d2"}',
  "data/table.csv": "a,b\n1,2\n",
}

async function serverProject(server: FakeProjectServer, title: string, contents: Record<string, string>, folders: string[] = []) {
  const remote = server.remote(person.id)
  const id = crypto.randomUUID()
  await remote.createProject(id, title)
  for (const [path, content] of Object.entries(contents)) await remote.saveFiles(id, crypto.randomUUID(), [{ op: "put", path, content }])
  for (const path of folders) await remote.saveFiles(id, crypto.randomUUID(), [{ op: "mkdir", path }])
  return id
}

async function openProject(page: Page, id: string) {
  await page.goto(projectUrl(id))
  await expect(page.getByRole("status").filter({ hasText: "Synced" })).toBeVisible({ timeout: 15_000 })
}

/** The entries of a downloaded .zip, by name. */
async function unzipped(download: Download) {
  return unzipSync(new Uint8Array(readFileSync((await download.path())!)))
}

/** Download from the project menu of the open project. */
async function downloadFromProjectMenu(page: Page, name: string) {
  await page.getByRole("button", { name: `${name}, project menu` }).click()
  const downloading = page.waitForEvent("download")
  await page.getByRole("menu").getByRole("menuitem", { name: "Download project" }).click()
  return downloading
}

/** Import `zip` from the projects home, through the menu and the file picker; returns the new project's id. */
async function importZip(page: Page, fake: FakeSupabase, name: string, zip: Buffer, report: string) {
  await page.goto(APP_URL)
  await expect(page.getByRole("heading", { name: "Your projects" })).toBeVisible()
  await page.getByRole("button", { name: "Import a folder or .zip" }).click()
  const choosing = page.waitForEvent("filechooser")
  await page.getByRole("menuitem", { name: "A .zip file" }).click()
  await (await choosing).setFiles({ name, mimeType: "application/zip", buffer: zip })
  const status = page.getByRole("status").filter({ hasText: "Imported" })
  await expect(status).toContainText(report)
  const href = await status.getByRole("link").getAttribute("href")
  const id = /\/projects\/([0-9a-f-]{36})$/.exec(href ?? "")![1]
  await expect.poll(() => fake.server.projects.has(id)).toBe(true)
  return id
}

test("a project downloads as a .zip of its files as saved, and the .zip imports back byte for byte", async ({ page }) => {
  const server = new FakeProjectServer()
  const id = await serverProject(server, "Product notes", files, ["empty-folder"])
  const fake = await fakeSupabase(page, { server })
  await signedIn(page)
  await openProject(page, id)

  const download = await downloadFromProjectMenu(page, "Product notes")
  expect(download.suggestedFilename()).toBe("Product notes.zip")
  const entries = await unzipped(download)
  expect(Object.keys(entries).sort()).toEqual([...Object.keys(files), "empty-folder/"].sort())
  for (const [path, content] of Object.entries(files)) expect(Buffer.from(entries[path]).equals(Buffer.from(content, "utf8"))).toBe(true)

  const copy = await importZip(page, fake, "Product notes.zip", readFileSync((await download.path())!), "Imported Product notes: 7 files and 1 folder.")
  for (const [path, content] of Object.entries(files)) await expect.poll(() => fake.server.content(copy, path)).toBe(content)
  expect(fake.server.paths(copy)).toEqual(Object.keys(files).sort())
  await expect.poll(() => [...fake.server.projects.get(copy)!.folders]).toEqual(["empty-folder"])
})

test("the projects home downloads a project from its card, even one not on this device yet", async ({ page }) => {
  const server = new FakeProjectServer()
  await serverProject(server, "Notes: 2026/Q3", { "a.md": "# A\n" })
  await fakeSupabase(page, { server })
  await signedIn(page)
  await page.goto(APP_URL)
  await page.getByRole("button", { name: "Actions for Notes: 2026/Q3" }).click()
  const downloading = page.waitForEvent("download")
  await page.getByRole("menuitem", { name: "Download project" }).click()
  const download = await downloading
  expect(download.suggestedFilename()).toBe("Notes- 2026-Q3.zip")
  expect(Object.keys(await unzipped(download))).toEqual(["a.md"])
})

test("unsaved changes are left out of a download unless they are included", async ({ page }) => {
  const server = new FakeProjectServer()
  const id = await serverProject(server, "Notes", { "a.md": "saved text" })
  await fakeSupabase(page, { server })
  await signedIn(page)
  await openProject(page, id)
  await page.getByRole("button", { name: "a.md", exact: true }).click()
  await page.locator(".monaco-editor:visible .view-lines").first().click()
  await page.keyboard.press("ControlOrMeta+End")
  await page.keyboard.type(", edited")
  await expect(page.getByRole("tab", { name: "a.md, unsaved changes", exact: true })).toBeVisible()

  await page.getByRole("button", { name: "Notes, project menu" }).click()
  await page.getByRole("menu").getByRole("menuitem", { name: "Download project" }).click()
  const dialog = page.getByRole("dialog", { name: "Download Notes" })
  await expect(dialog).toContainText("1 file has unsaved changes.")
  let downloading = page.waitForEvent("download")
  await dialog.getByRole("button", { name: "Download" }).click()
  expect(new TextDecoder().decode((await unzipped(await downloading))["a.md"])).toBe("saved text")
  await expect(dialog).toBeHidden()

  await page.getByRole("button", { name: "Notes, project menu" }).click()
  await page.getByRole("menu").getByRole("menuitem", { name: "Download project" }).click()
  await dialog.getByRole("switch", { name: "Include unsaved changes" }).click()
  downloading = page.waitForEvent("download")
  await dialog.getByRole("button", { name: "Download" }).click()
  expect(new TextDecoder().decode((await unzipped(await downloading))["a.md"])).toBe("saved text, edited")
})

test("without an account, the local project downloads too", async ({ page }) => {
  await fakeSupabase(page)
  await page.goto(APP_URL)
  await page.getByRole("banner").getByRole("link", { name: "Start writing" }).click()
  await expect(page.getByRole("heading", { level: 1, name: "Local project" })).toBeVisible({ timeout: 15_000 })
  await page.getByRole("button", { name: "New file" }).click()
  await page.getByRole("menuitem", { name: "New note", exact: true }).click()
  await expect(page.getByRole("textbox", { name: /^Name of the new note in / })).toBeFocused()
  await page.keyboard.type("ideas")
  await page.keyboard.press("Enter")
  await page.locator(".monaco-editor:visible .view-lines").first().click()
  await page.keyboard.type("Kept in this browser.")
  const unsaved = page.getByRole("tab", { name: "ideas.mdx, unsaved changes", exact: true })
  await expect(unsaved).toBeVisible()
  await page.keyboard.press("ControlOrMeta+s")
  await expect(unsaved).toHaveCount(0)

  const download = await downloadFromProjectMenu(page, "Local project")
  expect(download.suggestedFilename()).toBe("Local project.zip")
  expect(new TextDecoder().decode((await unzipped(download))["ideas.mdx"])).toContain("Kept in this browser.")
})

test("a folder imports as a new project named after it, and what cannot be stored is listed", async ({ page }, testInfo) => {
  const folder = testInfo.outputPath("Field notes")
  const write = (path: string, content: string | Buffer) => {
    mkdirSync(dirname(join(folder, path)), { recursive: true })
    writeFileSync(join(folder, path), content)
  }
  write("a.md", "# A\r\n")
  write("sub/b.mdx", "b 🙂\n")
  write("photo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00]))
  const fake = await fakeSupabase(page)
  await signedIn(page)
  await page.goto(APP_URL)
  await expect(page.getByRole("heading", { name: "Your projects" })).toBeVisible()
  await page.getByLabel("Import a folder", { exact: true }).setInputFiles(folder)
  const status = page.getByRole("status").filter({ hasText: "Imported" })
  await expect(status).toContainText("Imported Field notes: 2 files and 0 folders.")
  await expect(status.getByRole("listitem")).toHaveText(["photo.png The file is not UTF-8 text, and this app stores only text."])
  const id = /\/projects\/([0-9a-f-]{36})$/.exec((await status.getByRole("link").getAttribute("href")) ?? "")![1]
  await expect.poll(() => fake.server.content(id, "a.md")).toBe("# A\r\n")
  await expect.poll(() => fake.server.content(id, "sub/b.mdx")).toBe("b 🙂\n")
})

test("a file that is not a .zip says so and creates nothing", async ({ page }) => {
  const fake = await fakeSupabase(page)
  await signedIn(page)
  await page.goto(APP_URL)
  await page.getByLabel("Import a .zip file", { exact: true }).setInputFiles({ name: "notes.zip", mimeType: "application/zip", buffer: Buffer.from("not a zip at all, only some text") })
  await expect(page.getByRole("alert")).toHaveText("notes.zip could not be imported. This file is not a .zip archive, or it is damaged.")
  expect(fake.server.projects.size).toBe(0)
})

test("a project with nothing in it says so instead of saving an empty .zip", async ({ page }) => {
  const server = new FakeProjectServer()
  await serverProject(server, "Empty", {})
  await fakeSupabase(page, { server })
  await signedIn(page)
  await page.goto(APP_URL)
  let downloads = 0
  page.on("download", () => downloads++)
  await page.getByRole("button", { name: "Actions for Empty" }).click()
  await page.getByRole("menuitem", { name: "Download project" }).click()
  // Nothing went wrong, so it is a notice the person can dismiss.
  const notice = page.getByRole("status").filter({ hasText: "Nothing to download: this project has no saved files or folders yet." })
  await expect(notice).toBeVisible()
  await expect(page.getByRole("alert")).toHaveCount(0)
  expect(downloads).toBe(0)
  await notice.getByRole("button", { name: "Dismiss" }).click()
  await expect(notice).toHaveCount(0)
})
