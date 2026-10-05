import { expect, test, type Page } from "@playwright/test"
import { fakeSupabase, otpCode, person, quiet, session, type FakeSupabase } from "./fake-supabase.ts"
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
  await remote.saveFiles(id, crypto.randomUUID(), [{ op: "put", path: "notes/plan.md", content: "# Plan\n\nHello from the panel.\n" }])
  await signedInPanel(page)
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

  await app.getByRole("link", { name: "Launch plan" }).click()
  await expect.poll(() => html.url()).toMatch(new RegExp(`^${APP}/embed/projects/${id}`))
  // A project opens its first note.
  await expect(app.getByRole("tab", { name: "notes/plan.md" })).toBeVisible({ timeout: 15_000 })
  await expect(app.getByRole("link", { name: "Projects", exact: true })).toBeVisible()

  // The note renders, in the srcdoc frame.
  await app.getByRole("button", { name: "Rendered", exact: true }).click()
  const preview = app.locator('iframe[title="Isolated document preview"]')
  await expect(app.frameLocator('iframe[title="Isolated document preview"]').getByText("Hello from the panel.")).toBeVisible({ timeout: 20_000 })
  expect(await preview.getAttribute("src")).toBeNull()

  // Open in elaborat.ing goes to the view, which opens it through the chat.
  await app.getByRole("link", { name: "Open in elaborat.ing" }).click()
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
