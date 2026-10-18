import { expect, test, type FrameLocator, type Page } from "./fixtures.ts"
import { fakeSupabase, otpCode, person, quiet, session, signedIn, type FakeSupabase } from "./fake-supabase.ts"
import { APP_URL, HARNESS_URL } from "./urls.ts"

// The app in a chat's panel: APP_URL/embed framed by a page on another
// origin (the harness's), as a chat's view frames it, against the stand-in
// Supabase. The page records the messages the app sends it. The view puts a
// pass from the MCP server in the address (#pass=), which the app redeems
// before it shows any project; `fake.mintPanelPass()` stands in for the server.

test.describe.configure({ timeout: 60_000 })

const APP = new URL(APP_URL).origin

type Message = { origin: string; data: { type?: string; url?: string } }

/** The project data the app reads: every database request except redeeming a pass. */
const projectReads = (fake: FakeSupabase) =>
  fake.requests.map((request) => new URL(request.url()).pathname).filter((path) => path.startsWith("/rest/v1/") && path !== "/rest/v1/rpc/redeem_panel_pass")

/**
 * Open the panel's parent page, which frames `path` of the app. It is the
 * harness's own page with new content, so it stays on the harness's (local)
 * address: Chromium refuses a frame on a local address in a page it did not
 * get from one.
 */
async function openPanel(page: Page, path: string) {
  await page.goto(HARNESS_URL)
  await page.setContent(`<!doctype html><html lang="en"><head><title>Panel</title><style>html,body{margin:0;height:100%}iframe{display:block;width:100%;height:100%;border:0}</style></head>
<body><iframe id="app" title="elaborat.ing" src="${new URL(path, APP_URL).href}"></iframe>
<script>
  window.messages = [];
  addEventListener("message", (event) => {
    if (event.source === document.getElementById("app").contentWindow) window.messages.push({ origin: event.origin, data: event.data });
  });
</script></body></html>`)
  return page.frameLocator("#app")
}

const messages = (page: Page) => page.evaluate(() => (window as unknown as { messages: Message[] }).messages)

/** Signed in inside the app's frame only (its storage), as the panel keeps its own sign-in. */
async function signedInPanel(page: Page) {
  await page.addInitScript(
    ({ stored, origin }) => {
      if (location.origin === origin) localStorage.setItem("sb-127-auth-token", stored)
    },
    { stored: JSON.stringify(session()), origin: APP },
  )
}

test("signed out, the panel signs in with an emailed code or a password, and offers no passkey or provider", async ({ page }) => {
  const fake = await fakeSupabase(page, { passkeys: true, providers: { github: true, google: true } })
  const app = await openPanel(page, `embed#pass=${fake.mintPanelPass()}`)

  await expect(app.getByRole("heading", { name: "Sign in" })).toBeVisible()
  await expect(app.getByText("This panel keeps its own sign-in.")).toBeVisible()
  await expect(app.getByRole("button", { name: "Email me a code" })).toBeVisible()
  await expect.poll(() => messages(page)).toContainEqual({ origin: APP, data: { type: "elaborating-embed:ready" } })
  await expect(app.getByRole("button", { name: /passkey/i })).toHaveCount(0)
  await expect(app.getByRole("button", { name: /GitHub|Google/ })).toHaveCount(0)
  await expect(app.getByRole("link", { name: "Sign up" })).toHaveAttribute("href", `${APP}/sign-up`)
  await expect(app.getByRole("link", { name: "Sign up" })).toHaveAttribute("target", "_blank")

  await app.getByRole("button", { name: "Use a password instead" }).click()
  await expect(app.getByLabel("Password", { exact: true })).toBeVisible()
  await expect(app.getByRole("link", { name: "Forgot your password?" })).toHaveAttribute("href", `${APP}/forgot-password`)
  await app.getByRole("button", { name: "Email me a code instead" }).click()

  // The code from the email signs in here.
  await app.getByLabel("Email", { exact: true }).fill(person.email)
  await app.getByRole("button", { name: "Email me a code" }).click()
  await expect(app.getByText(`Check ${person.email} for a code and enter it here.`, { exact: false })).toBeVisible()
  await app.getByLabel("Code from the email").fill(otpCode)
  await app.getByRole("button", { name: "Sign in with the code" }).click()
  // Signed in, the page redeems its pass and shows the projects.
  await expect(app.getByRole("heading", { name: "Your projects" })).toBeVisible()
})

test("signed in, the panel lists the projects, opens one, and works with its view", async ({ page }) => {
  const fake = await fakeSupabase(page)
  const id = crypto.randomUUID()
  const remote = fake.server.remote(person.id)
  await remote.createProject(id, "Launch plan")
  await remote.saveFiles(id, crypto.randomUUID(), [{ op: "put", path: "notes/plan.md", content: "# Plan\n\nHello from the panel.\n\n[The docs](https://example.com/docs)\n" }])
  await signedInPanel(page)
  // Records whether the site's home page (its footer's links) ever shows in the panel.
  await page.addInitScript((origin) => {
    if (location.origin !== origin) return
    new MutationObserver(() => {
      if (document.querySelector('a[href$="/privacy"]')) (window as unknown as { sawSiteHome?: boolean }).sawSiteHome = true
    }).observe(document, { childList: true, subtree: true })
  }, APP)
  const nativeDialogs: string[] = []
  page.on("dialog", (dialog) => {
    nativeDialogs.push(dialog.message())
    void dialog.dismiss().catch(() => {})
  })
  const app = await openPanel(page, `embed?theme=dark#pass=${fake.mintPanelPass()}`)
  const html = page.frame({ url: (url) => url.origin === APP })!

  // ?theme=dark, then the view's theme message.
  await expect(app.getByRole("heading", { name: "Your projects" })).toBeVisible()
  // The pass left the address as soon as the page read it.
  expect(new URL(html.url()).hash).toBe("")
  expect(await html.evaluate(() => document.documentElement.dataset.scheme)).toBe("dark")
  expect(await html.evaluate(() => document.documentElement.hasAttribute("data-embed"))).toBe(true)
  // Project management is on the site: no import and no project menu here.
  await expect(app.getByRole("button", { name: /Import/ })).toHaveCount(0)
  await expect(app.getByRole("button", { name: "Actions for Launch plan" })).toHaveCount(0)

  // The project page's code arrives late: the panel shows the loading state
  // meanwhile, and never the site's home page.
  let release = () => {}
  const released = new Promise<void>((resolve) => (release = resolve))
  await page.route(/\/assets\/projects\._projectId-[\w-]+\.js$/, async (route) => {
    await released
    await route.continue()
  })
  await app.getByRole("link", { name: "Launch plan" }).click()
  await expect.poll(() => html.url()).toMatch(new RegExp(`^${APP}/embed/projects/${id}`))
  await expect(app.getByRole("status", { name: "Loading the page" })).toBeVisible()
  release()
  // A project opens its first note.
  await expect(app.getByRole("tab", { name: "notes/plan.md" })).toBeVisible({ timeout: 15_000 })
  expect(await html.evaluate(() => (window as unknown as { sawSiteHome?: boolean }).sawSiteHome)).toBeUndefined()
  // The workbench runs to the top, as on the site: no bar over it.
  await expect(app.locator('[data-slot="app-bar"]')).toHaveCount(0)

  // The note renders, in the srcdoc frame.
  await app.getByRole("button", { name: "Rendered", exact: true }).click()
  const preview = app.locator('iframe[title="Isolated document preview"]')
  await expect(app.frameLocator('iframe[title="Isolated document preview"]').getByText("Hello from the panel.")).toBeVisible({ timeout: 20_000 })
  expect(await preview.getAttribute("src")).toBeNull()
  // A web link in the note goes to the view too, which opens it through the chat.
  await app.frameLocator('iframe[title="Isolated document preview"]').getByRole("link", { name: "The docs" }).click()
  await expect.poll(() => messages(page)).toContainEqual({ origin: APP, data: { type: "elaborating-embed:open", url: "https://example.com/docs" } })
  expect(page.context().pages()).toHaveLength(1)

  // Open in elaborat.ing, in the project menu, goes to the view, which opens it through the chat.
  await app.getByRole("button", { name: "Launch plan, project menu" }).click()
  await app.getByRole("menuitem", { name: "Open in elaborat.ing" }).click()
  await expect
    .poll(() => messages(page))
    .toContainEqual({ origin: APP, data: { type: "elaborating-embed:open", url: `${APP}/projects/${id}/notes/plan.md` } })
  expect(page.context().pages()).toHaveLength(1)

  await page.evaluate(() => (document.getElementById("app") as HTMLIFrameElement).contentWindow!.postMessage({ type: "elaborating-embed:theme", theme: "light" }, "*"))
  await expect.poll(() => html.evaluate(() => document.documentElement.dataset.scheme)).toBe("light")

  // Closing a tab with unsaved edits asks in the page, not with the browser's dialog.
  await app.getByRole("button", { name: "Source", exact: true }).click()
  await app.locator(".monaco-editor:visible .view-lines").first().click()
  await page.keyboard.press("ControlOrMeta+End")
  await page.keyboard.type(" More.")
  const tab = app.getByRole("tab", { name: "notes/plan.md, unsaved changes" })
  await tab.press("Delete")
  const ask = app.getByRole("alertdialog")
  await expect(ask).toContainText("Close notes/plan.md and discard unsaved changes?")
  await ask.getByRole("button", { name: "Cancel" }).click()
  await expect(ask).toHaveCount(0)
  await expect(tab).toBeVisible()
  await tab.press("Delete")
  await app.getByRole("alertdialog").getByRole("button", { name: "Discard" }).click()
  await expect(app.getByRole("tab", { name: /notes\/plan\.md/ })).toHaveCount(0)
  expect(nativeDialogs).toEqual([])
})

test("the panel tells its view which project and file are open, and again when another file opens", async ({ page }) => {
  const fake = await fakeSupabase(page)
  const id = crypto.randomUUID()
  await fake.server.remote(person.id).createProject(id, "Launch plan")
  await fake.server.remote(person.id).saveFiles(id, crypto.randomUUID(), [
    { op: "put", path: "notes/plan.md", content: "# Plan\n" },
    { op: "put", path: "notes/flow.excalidraw", content: '{"type":"excalidraw","version":2,"elements":[]}' },
  ])
  await signedInPanel(page)
  const app = await openPanel(page, `embed/projects/${id}/notes/plan.md#pass=${fake.mintPanelPass()}`)
  const location = (file: { path: string; kind: string }) => ({ origin: APP, data: { type: "elaborating-embed:location", project: { id, name: "Launch plan" }, file } })

  await expect(app.getByRole("tab", { name: "notes/plan.md" })).toBeVisible({ timeout: 15_000 })
  await expect.poll(() => messages(page)).toContainEqual(location({ path: "notes/plan.md", kind: "note" }))

  await app.getByRole("button", { name: "notes/flow.excalidraw", exact: true }).click()
  await expect.poll(() => messages(page)).toContainEqual(location({ path: "notes/flow.excalidraw", kind: "drawing" }))

  // With a drawing open the workbench still runs to the top, with no bar, and All projects goes home.
  await expect(app.locator("[data-canvas-stage]")).toBeVisible({ timeout: 15_000 })
  await expect(app.locator('[data-slot="app-bar"]')).toHaveCount(0)
  const menu = app.getByRole("button", { name: "Launch plan, project menu" })
  expect(await menu.evaluate((element) => element.getBoundingClientRect().top)).toBeLessThan(40)
  await menu.click()
  await app.getByRole("menuitem", { name: "All projects" }).click()
  await expect(app.getByRole("heading", { name: "Your projects" })).toBeVisible()
})

// Following the agent: in the panel, a save one of the person's agents makes
// to a note, drawing or diagram other than the one on screen opens that file,
// which fills in as the agent's work, unless the person is in the middle of
// something there. The panel looks at the agent's saves on each change
// signal, after a first look when the project opens.

const PLAN = "# Plan\n\nWhat ships on day one.\n"
const RISKS = `# Risks\n\n${Array.from({ length: 6 }, (_, at) => `Risk ${at + 1}: the import may stall on a large file, and nobody has tried a restore yet.`).join("\n\n")}\n`
const shape = (id: string, index: string, x: number, color: string) => ({
  id, type: "rectangle", x, y: 40, width: 160, height: 100, angle: 0, strokeColor: color, backgroundColor: color, fillStyle: "solid",
  strokeWidth: 2, strokeStyle: "solid", roughness: 0, opacity: 100, groupIds: [], frameId: null, index, roundness: null, seed: 7,
  version: 1, versionNonce: 7, isDeleted: false, boundElements: [], updated: 1, link: null, locked: false,
})
const drawing = (...elements: object[]) => `${JSON.stringify({ type: "excalidraw", version: 2, elements, appState: { viewBackgroundColor: "#ffffff" }, files: {} })}\n`
const FLOW = drawing(shape("client", "a0", 0, "#e03131"), shape("store", "a1", 240, "#1971c2"))
const SLOW = "The import is slow: every row is checked twice, once as it is read and again before it is saved, so a large file can take minutes."

const agentLooks = (fake: FakeSupabase) => fake.requests.filter((request) => request.url().endsWith("/rpc/list_agent_changes")).length
const saveCalls = (fake: FakeSupabase) => fake.requests.filter((request) => request.url().endsWith("/rpc/save_files")).length

/** The project in the panel at `path`, once the panel has had its first look at the agent's saves: those after it are followed. */
async function followingPanel(page: Page, files: Record<string, string>, path: string) {
  const fake = await fakeSupabase(page)
  const id = crypto.randomUUID()
  const remote = fake.server.remote(person.id)
  await remote.createProject(id, "Launch plan")
  for (const [file, content] of Object.entries(files)) await remote.saveFiles(id, crypto.randomUUID(), [{ op: "put", path: file, content }])
  await signedInPanel(page)
  const app = await openPanel(page, `embed/projects/${id}/${path}#pass=${fake.mintPanelPass()}`)
  await expect(app.getByRole("tab", { name: path })).toHaveAttribute("aria-selected", "true", { timeout: 15_000 })
  await expect.poll(() => agentLooks(fake)).toBeGreaterThan(0)
  return { fake, id, app, html: page.frame({ url: (url) => url.origin === APP })! }
}

/** One of the person's agents saves `path`, a new version on the server, and the change signal goes out. */
async function agentSaves(fake: FakeSupabase, id: string, path: string, content: string) {
  await fake.agentChanges.save(person.id, id, path, content)
  fake.signal(id, fake.server.projects.get(id)!.revision)
}

/** Press `key` every 400 ms for about two and a half seconds, as someone working in the panel. */
async function keepPressing(page: Page, key: string) {
  for (let press = 0; press < 6; press++) {
    await page.keyboard.press(key)
    await page.waitForTimeout(400)
  }
}

test("in the panel a drawing an agent makes opens in place of the note on screen, and its elements are sketched in, with nothing to save", async ({ page }) => {
  const { fake, id, app, html } = await followingPanel(page, { "notes/plan.md": PLAN }, "notes/plan.md")
  // Records each element the canvas sketches in, by id.
  await html.evaluate(() => {
    const sketched = new Set<string>()
    Object.assign(window, { sketched })
    new MutationObserver(() => {
      for (const element of document.querySelectorAll<SVGElement>("[data-sketch] [data-sketch-id]")) sketched.add(element.dataset.sketchId!)
    }).observe(document.body, { childList: true, subtree: true })
  })
  const saves = saveCalls(fake)

  await agentSaves(fake, id, "notes/flow.excalidraw", FLOW)
  await expect(app.getByRole("tab", { name: "notes/flow.excalidraw" })).toHaveAttribute("aria-selected", "true", { timeout: 15_000 })
  await expect(app.locator(".wb-native-view [aria-live]").first()).toContainText("2 elements")
  // It opened empty, then both elements were sketched in, and the sketch went.
  await expect.poll(() => html.evaluate(() => [...(window as unknown as { sketched: Set<string> }).sketched].sort())).toEqual(["client", "store"])
  await expect(app.locator("[data-sketch]")).toHaveCount(0, { timeout: 15_000 })
  // Nothing of it is unsaved or saved again, and the view hears that the drawing is open.
  await expect(app.locator(".wb-native-view [aria-live]").first()).toContainText("Saved")
  await expect(app.getByRole("tab", { name: /unsaved changes/ })).toHaveCount(0)
  expect(saveCalls(fake)).toBe(saves)
  expect(fake.server.content(id, "notes/flow.excalidraw")).toBe(FLOW)
  await expect
    .poll(() => messages(page))
    .toContainEqual({ origin: APP, data: { type: "elaborating-embed:location", project: { id, name: "Launch plan" }, file: { path: "notes/flow.excalidraw", kind: "drawing" } } })
})

test("in the panel a note an agent changes does not open over unsaved edits, or while the person types, and the agent's next save once they stop opens it and writes it in", async ({ page }) => {
  const { fake, id, app } = await followingPanel(page, { "notes/plan.md": PLAN, "notes/risks.md": "# Risks\n" }, "notes/plan.md")
  const risksTab = app.getByRole("tab", { name: /notes\/risks\.md/ })
  const risks = app.getByRole("tabpanel", { name: "notes/risks.md" })
  const risksFrame = risks.frameLocator('iframe[title="Isolated document preview"]')

  // The person read the risks in Split before, so the note opens that way again.
  await app.getByRole("button", { name: "notes/risks.md", exact: true }).click()
  await app.getByRole("button", { name: "Split", exact: true }).click()
  await expect(risksFrame.getByRole("heading", { name: "Risks" })).toBeVisible({ timeout: 20_000 })
  await app.getByRole("tab", { name: "notes/risks.md" }).press("Delete")
  await expect(risksTab).toHaveCount(0)
  await expect(app.getByRole("tab", { name: "notes/plan.md" })).toHaveAttribute("aria-selected", "true")

  // Unsaved edits in the note on screen, typed a while before the agent saves.
  await app.locator(".monaco-editor:visible .view-lines").first().click()
  await page.keyboard.press("ControlOrMeta+End")
  await page.keyboard.type(" Draft.")
  const draft = app.getByRole("tab", { name: "notes/plan.md, unsaved changes" })
  await expect(draft).toBeVisible()
  await page.waitForTimeout(3_500)
  let looks = agentLooks(fake)
  await agentSaves(fake, id, "notes/risks.md", "# Risks\n\nThe import is slow.\n")
  await expect(app.getByRole("button", { name: "Agent changes, 1 new" })).toBeVisible()
  await expect.poll(() => agentLooks(fake)).toBeGreaterThan(looks)
  await page.waitForTimeout(1_500)
  await expect(draft).toHaveAttribute("aria-selected", "true")
  await expect(risksTab).toHaveCount(0)

  // Saved, but still at the keyboard.
  await page.keyboard.press("ControlOrMeta+s")
  const plan = app.getByRole("tab", { name: "notes/plan.md", exact: true })
  await expect(plan).toBeVisible()
  looks = agentLooks(fake)
  await agentSaves(fake, id, "notes/risks.md", "# Risks\n\nThe import is slow.\n\nThe export is slower.\n")
  await keepPressing(page, "ArrowLeft")
  await expect(app.getByRole("button", { name: "Agent changes, 2 new" })).toBeVisible()
  await expect.poll(() => agentLooks(fake)).toBeGreaterThan(looks)
  await expect(plan).toHaveAttribute("aria-selected", "true")
  await expect(risksTab).toHaveCount(0)

  // Left alone, the agent's next save opens the note, which starts empty and
  // writes in behind a caret, in Source and in Rendered.
  await page.waitForTimeout(3_500)
  await agentSaves(fake, id, "notes/risks.md", RISKS)
  await expect(app.getByRole("tab", { name: "notes/risks.md" })).toHaveAttribute("aria-selected", "true", { timeout: 15_000 })
  const source = risks.locator(".monaco-editor")
  await expect.poll(() => source.locator(".source-writing-caret").count(), { intervals: [50] }).toBeGreaterThan(0)
  await expect.poll(() => risksFrame.locator(".type-in-caret").count(), { intervals: [50] }).toBeGreaterThan(0)
  await expect(risksFrame.getByText("Risk 6: the import may stall", { exact: false })).toBeVisible({ timeout: 15_000 })
  await expect(risksFrame.locator(".type-in-caret")).toHaveCount(0, { timeout: 15_000 })
  await expect(source.locator(".source-writing-caret")).toHaveCount(0, { timeout: 15_000 })
  await expect(source.locator(".view-lines")).toContainText("Risk 6: the import may stall")
  await expect(app.getByRole("tab", { name: /unsaved changes/ })).toHaveCount(0)
  expect(fake.server.content(id, "notes/risks.md")).toBe(RISKS)
  expect(fake.server.content(id, "notes/plan.md")).toBe(`${PLAN} Draft.`)
})

/** One of the person's agents saves `path` while they turn the wheel over the drawing on screen, so the panel stays where it is; once the panel has looked at the save. */
async function agentSavesWhileDrawing(page: Page, app: FrameLocator, fake: FakeSupabase, id: string, path: string, content: string) {
  const canvas = (await app.locator("[data-canvas-stage]").boundingBox())!
  await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2)
  const looks = agentLooks(fake)
  await agentSaves(fake, id, path, content)
  for (let turn = 0; turn < 6; turn++) {
    await page.mouse.wheel(0, 40)
    await page.waitForTimeout(400)
  }
  await expect.poll(() => agentLooks(fake)).toBeGreaterThan(looks)
}

test("in the panel a note or a drawing behind another tab writes in or sketches in an agent's save once it comes forward", async ({ page }) => {
  const { fake, id, app, html } = await followingPanel(page, { "notes/plan.md": PLAN, "notes/flow.excalidraw": FLOW }, "notes/plan.md")
  const plan = app.getByRole("tabpanel", { name: "notes/plan.md", includeHidden: true })
  const planFrame = plan.frameLocator('iframe[title="Isolated document preview"]')
  const drawingTab = app.getByRole("tab", { name: "notes/flow.excalidraw" })
  const drawingStatus = app.locator(".wb-native-view [aria-live]").first()
  // The person reads the plan in Split, then opens the drawing in front of it.
  await app.getByRole("button", { name: "Split", exact: true }).click()
  await expect(planFrame.getByRole("heading", { name: "Plan" })).toBeVisible({ timeout: 20_000 })
  await app.getByRole("button", { name: "notes/flow.excalidraw", exact: true }).click()
  await expect(drawingStatus).toContainText("2 elements", { timeout: 15_000 })

  // While they work on the drawing, the agent adds to the plan, which stays behind it as it was.
  await agentSavesWhileDrawing(page, app, fake, id, "notes/plan.md", `${PLAN}\n${SLOW}\n`)
  // Longer than writing that in takes, so only a save still to be taken can write in now.
  await page.waitForTimeout(2_000)
  await expect(drawingTab).toHaveAttribute("aria-selected", "true")

  // Brought forward, the plan writes in what the agent added, in Source and in Rendered.
  await app.getByRole("tab", { name: "notes/plan.md" }).click()
  await expect.poll(() => plan.locator(".monaco-editor .source-writing-caret").count(), { intervals: [50] }).toBeGreaterThan(0)
  await expect.poll(() => planFrame.locator(".type-in-caret").count(), { intervals: [50] }).toBeGreaterThan(0)
  await expect(planFrame.getByText(SLOW)).toBeVisible({ timeout: 15_000 })
  await expect(planFrame.getByText("What ships on day one.")).toBeVisible()
  await expect(app.getByText(/Preview failed/)).toHaveCount(0)

  // Left alone, the agent adds a box to the drawing behind the plan: the
  // panel brings it forward and sketches in the box, and only the box.
  await html.evaluate(() => {
    const sketched = new Set<string>()
    Object.assign(window, { sketched })
    new MutationObserver(() => {
      for (const element of document.querySelectorAll<SVGElement>("[data-sketch] [data-sketch-id]")) sketched.add(element.dataset.sketchId!)
    }).observe(document.body, { childList: true, subtree: true })
  })
  await page.waitForTimeout(3_500)
  await agentSaves(fake, id, "notes/flow.excalidraw", drawing(shape("client", "a0", 0, "#e03131"), shape("store", "a1", 240, "#1971c2"), shape("queue", "a2", 480, "#2f9e44")))
  await expect(drawingTab).toHaveAttribute("aria-selected", "true", { timeout: 15_000 })
  await expect(drawingStatus).toContainText("3 elements")
  await expect.poll(() => html.evaluate(() => [...(window as unknown as { sketched: Set<string> }).sketched])).toEqual(["queue"])
  await expect(app.locator("[data-sketch]")).toHaveCount(0, { timeout: 15_000 })
  await expect(app.getByRole("tab", { name: /unsaved changes/ })).toHaveCount(0)
})

test("in the panel a note behind another tab, still showing what it had before an agent's save, is not kept as a draft of that when the person leaves the project", async ({ page }) => {
  const { fake, id, app } = await followingPanel(page, { "notes/plan.md": PLAN, "notes/flow.excalidraw": FLOW }, "notes/plan.md")
  await app.getByRole("button", { name: "notes/flow.excalidraw", exact: true }).click()
  await expect(app.locator(".wb-native-view [aria-live]").first()).toContainText("2 elements", { timeout: 15_000 })
  await agentSavesWhileDrawing(page, app, fake, id, "notes/plan.md", `${PLAN}\n${SLOW}\n`)

  // Leaving keeps the unsaved edits of every open file on the device: the plan has none.
  await app.getByRole("button", { name: "Launch plan, project menu" }).click()
  await app.getByRole("menuitem", { name: "All projects" }).click()
  await expect(app.getByRole("heading", { name: "Your projects" })).toBeVisible()
  await app.getByRole("link", { name: "Launch plan" }).click()
  await app.getByRole("tab", { name: /notes\/plan\.md/ }).click({ timeout: 15_000 })
  await expect(app.getByRole("tab", { name: "notes/plan.md", exact: true })).toHaveAttribute("aria-selected", "true")
  await expect(app.locator(".monaco-editor:visible .view-lines").first()).toContainText("The import is slow")
  await expect(app.getByRole("tab", { name: /unsaved changes/ })).toHaveCount(0)
})

test("on the site, a drawing an agent makes does not open in place of the note on screen", async ({ page }) => {
  const fake = await fakeSupabase(page)
  const id = crypto.randomUUID()
  const remote = fake.server.remote(person.id)
  await remote.createProject(id, "Launch plan")
  await remote.saveFiles(id, crypto.randomUUID(), [{ op: "put", path: "notes/plan.md", content: PLAN }])
  await signedIn(page)
  await page.goto(new URL(`projects/${id}/notes/plan.md`, APP_URL).href)
  await expect(page.getByRole("status").filter({ hasText: "Synced" })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole("tab", { name: "notes/plan.md" })).toHaveAttribute("aria-selected", "true")

  await agentSaves(fake, id, "notes/flow.excalidraw", FLOW)
  await expect(page.getByRole("button", { name: "Agent changes, 1 new" })).toBeVisible()
  // The drawing is here, in the files, and stays there.
  await expect(page.getByRole("button", { name: "notes/flow.excalidraw", exact: true })).toBeVisible()
  await page.waitForTimeout(1_500)
  await expect(page.getByRole("tab", { name: "notes/plan.md" })).toHaveAttribute("aria-selected", "true")
  await expect(page.getByRole("tab", { name: "notes/flow.excalidraw" })).toHaveCount(0)
  expect(agentLooks(fake)).toBe(0)
})

const LOCKED = "Open this from elaborat.ing in your ChatGPT sidebar."

test("signed in, without a pass that works the panel shows only a way to the site, and reads no project", async ({ page }) => {
  const fake = await fakeSupabase(page)
  await fake.server.remote(person.id).createProject(crypto.randomUUID(), "Launch plan")
  await signedInPanel(page)

  for (const path of ["embed", `embed#pass=${"0".repeat(64)}`, "embed#pass=not-a-pass"]) {
    const app = await openPanel(page, path)
    await expect(app.getByText(LOCKED)).toBeVisible()
    await expect(app.getByRole("main").getByRole("link", { name: "Open in elaborat.ing" })).toHaveAttribute("href", `${APP}/`)
    await expect(app.getByRole("heading", { name: "Your projects" })).toHaveCount(0)
    await expect(app.getByText("Launch plan")).toHaveCount(0)
    // It asks the view for a new pass.
    await expect.poll(() => messages(page)).toContainEqual({ origin: APP, data: { type: "elaborating-embed:pass" } })
  }
  await quiet(fake)
  expect(projectReads(fake)).toEqual([])
})

test("a pass opens the panel for that page load only", async ({ page }) => {
  const fake = await fakeSupabase(page)
  await fake.server.remote(person.id).createProject(crypto.randomUUID(), "Launch plan")
  await signedInPanel(page)
  const pass = fake.mintPanelPass()

  const app = await openPanel(page, `embed#pass=${pass}`)
  await expect(app.getByRole("link", { name: "Launch plan" })).toBeVisible()
  expect(projectReads(fake).length).toBeGreaterThan(0)

  // The same page loaded again has no pass: nothing of the account shows.
  const html = page.frame({ url: (url) => url.origin === APP })!
  await html.evaluate(() => location.reload())
  await expect(app.getByText(LOCKED)).toBeVisible()
  await expect(app.getByRole("link", { name: "Launch plan" })).toHaveCount(0)

  // And a pass already used does not open it again.
  const again = await openPanel(page, `embed#pass=${pass}`)
  await expect(again.getByText(LOCKED)).toBeVisible()
  await expect(again.getByRole("link", { name: "Launch plan" })).toHaveCount(0)
})

test("opened on its own, /embed goes to the same page on the site, without the pass", async ({ page }) => {
  await fakeSupabase(page)
  const id = crypto.randomUUID()
  await page.goto(new URL(`embed/projects/${id}#pass=${"a".repeat(64)}`, APP_URL).href)
  await expect(page).toHaveURL(new URL(`projects/${id}`, APP_URL).href)
})
