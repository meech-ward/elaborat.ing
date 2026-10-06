import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { FILE_VIEW_HTML } from "../../supabase/functions/mcp-server/tools/fileViewHtml.ts"

// The show_file view (the chat card) in a stand-in MCP Apps host: a page that
// frames the view the way Claude and ChatGPT do (sandboxed, under the policy
// the view declares: the spec's default plus resources from elaborat.ing) and
// answers its bridge messages. The note is edited in the card and saved with
// write_file. The card loads its editor and component previews from
// elaborat.ing, which the tests answer from public/chat-card; a host that
// allows only the default policy gets the card without them.

const PROJECT = "6f1c2d3e-4b5a-4c6d-8e7f-901a2b3c4d5e"
const PATH = "notes/plan.mdx"
const URL = `https://elaborat.ing/projects/${PROJECT}/notes/plan.mdx`

// Formatting a rewrite would change: frontmatter, an import, spacing, `+`
// markers, `__strong__`, a titled link, an embed, MDX, a table and a fence.
const SOURCE = [
  "---",
  "title: Launch plan",
  "---",
  "import { Chart } from 'workspace:components/chart.mdx'",
  "",
  "# Launch   plan",
  "",
  'Ship it *soon*, with __care__ and a [link](https://example.com "Title").',
  "Second line of the same paragraph.",
  "",
  "+ first item",
  "+ second item",
  "",
  '<Drawing src="art/flow.excalidraw" />',
  "",
  '<Callout type="note">Keep this as it is.</Callout>',
  "",
  "| a | b |",
  "|---|---|",
  "| 1 | 2 |",
  "",
  "```js",
  "const x = 1",
  "```",
  "",
].join("\n")

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40" width="120" height="40"><rect x="4" y="4" width="112" height="32" rx="6" fill="none" stroke="#1e1e1e"/></svg>'

/** A show_file result like the server's, for one version of the note. */
function shown(version: number, source: string) {
  return {
    content: [{ type: "text", text: `Showing ${PATH} (version ${version}) to the user.` }],
    structuredContent: {
      project_id: PROJECT,
      path: PATH,
      kind: "note",
      version,
      updated_at: null,
      url: URL,
      truncated: false,
      embeds: [{ kind: "drawing", path: "art/flow.excalidraw", url: `https://elaborat.ing/projects/${PROJECT}/art/flow.excalidraw`, status: "drawn" }],
    },
    _meta: {
      "elaborat.ing/html": `<h1>Launch plan</h1><p>Version ${version} as rendered by the server.</p><figure class="embed" data-embed="0"></figure>`,
      "elaborat.ing/svg": { "art/flow.excalidraw": SVG },
      "elaborat.ing/source": source,
    },
  }
}

// The spec's default policy for a view that declares no `_meta.ui.csp`, and
// the policy for the view's declaration (fileView.ts): resourceDomains adds
// its origin to script-src, style-src, img-src, font-src and media-src.
const DEFAULT_CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' data:; connect-src 'none'; object-src 'none'"
const APP = "https://elaborat.ing"
const DECLARED_CSP = `default-src 'none'; script-src 'self' 'unsafe-inline' ${APP}; style-src 'self' 'unsafe-inline' ${APP}; img-src 'self' data: ${APP}; font-src ${APP}; media-src 'self' data: ${APP}; connect-src 'none'; object-src 'none'`

/**
 * The host's policy for the view: the one it declares, the default one from a
 * host that does not say, or the default one from a host that says in
 * `hostCapabilities.sandbox.csp` that it allows no resource origins.
 */
type Policy = "declared" | "default" | "default-said"
/**
 * `chatgpt`: the host puts window.openai in the frame, as ChatGPT does.
 * `modes`: the display modes the host offers (`availableDisplayModes`).
 * `manual`: the host sends nothing once the view is ready; the test sends
 * the tool's input and result with `send`.
 */
type Host = { tools: boolean; theme: "light" | "dark"; result: unknown; styles?: unknown; policy?: Policy; chatgpt?: boolean; modes?: string[]; manual?: boolean }

const MODULES = path.join(import.meta.dirname, "..", "..", "public", "chat-card")

const askedFor = new WeakMap<Page, string[]>()
/** The card's files asked for so far, by name without their hash ("editor", "documentCharts", "excalifont-latin"). */
const asked = (page: Page) => (askedFor.get(page) ?? []).map((file) => file.replace(/-[\w-]{8}\.\w+$/, ""))

/** Answers elaborat.ing's /chat-card/ as the site does (public/_headers), and notes each file asked for. */
async function serveModules(page: Page) {
  const asked: string[] = []
  askedFor.set(page, asked)
  await page.route(`${APP}/chat-card/**`, (route) => {
    const name = new globalThis.URL(route.request().url()).pathname.replace(/^\/chat-card\//, "")
    asked.push(name)
    const file = path.join(MODULES, name)
    if (!/^[\w.-]+$/.test(name) || !existsSync(file)) return route.fulfill({ status: 404 })
    return route.fulfill({
      body: readFileSync(file),
      contentType: name.endsWith(".css") ? "text/css" : name.endsWith(".woff2") ? "font/woff2" : "text/javascript",
      headers: { "access-control-allow-origin": "*" },
    })
  })
}

/** Opens the stand-in host with the view in it; answers come from window.answers. */
async function openHost(page: Page, host: Host) {
  const policy = host.policy ?? "declared"
  const csp = policy === "declared" ? DECLARED_CSP : DEFAULT_CSP
  const sandbox = policy === "declared" ? { csp: { resourceDomains: [APP] } } : policy === "default-said" ? { csp: {} } : undefined
  const view = FILE_VIEW_HTML.replace(
    "<head>",
    `<head><meta http-equiv="Content-Security-Policy" content="${csp}"><script>${host.chatgpt ? "window.openai={};" : ""}window.violations=[];document.addEventListener('securitypolicyviolation',(e)=>window.violations.push(e.violatedDirective+' '+e.blockedURI))</script>`,
  )
  await serveModules(page)
  await page.route("https://host.test/", (route) =>
    route.fulfill({ contentType: "text/html", body: '<!doctype html><html><body style="margin:0"><iframe sandbox="allow-scripts" style="width:100%;height:900px;border:0"></iframe></body></html>' }),
  )
  await page.goto("https://host.test/")
  await page.evaluate(
    ({ view, host }) => {
      const state = window as unknown as Record<string, unknown>
      const calls: unknown[] = []
      const contexts: unknown[] = []
      const sizes: unknown[] = []
      const links: unknown[] = []
      const displayModes: unknown[] = []
      state.displayModes = displayModes
      state.calls = calls
      state.contexts = contexts
      state.sizes = sizes
      state.links = links
      state.answers = {}
      const frame = document.querySelector("iframe")!
      const reply = (id: unknown, result: unknown) => frame.contentWindow!.postMessage({ jsonrpc: "2.0", id, result }, "*")
      const send = (method: string, params: unknown) => frame.contentWindow!.postMessage({ jsonrpc: "2.0", method, params }, "*")
      state.send = send
      window.addEventListener("message", (event) => {
        if (event.source !== frame.contentWindow) return
        const message = event.data as { id?: unknown; method?: string; params?: { name: string; arguments: unknown } }
        if (message.method === "ui/initialize") {
          state.initialize = message.params
          reply(message.id, {
            protocolVersion: "2026-01-26",
            hostInfo: { name: "stand-in", version: "1.0.0" },
            hostCapabilities: { ...(host.tools ? { serverTools: {}, openLinks: {} } : { openLinks: {} }), ...(host.sandbox ? { sandbox: host.sandbox } : {}) },
            hostContext: { theme: host.theme, styles: host.styles, displayMode: "inline", ...(host.modes ? { availableDisplayModes: host.modes } : {}) },
          })
        } else if (message.method === "ui/request-display-mode") {
          const { mode } = message.params as unknown as { mode: string }
          displayModes.push(mode)
          reply(message.id, { mode })
          send("ui/notifications/host-context-changed", { displayMode: mode })
        } else if (message.method === "ui/notifications/initialized") {
          state.ready = true
          if (host.manual) return
          send("ui/notifications/tool-input", { arguments: { project_id: "p", path: "notes/plan.mdx" } })
          send("ui/notifications/tool-result", host.result)
        } else if (message.method === "tools/call") {
          calls.push(message.params)
          const queue = (state.answers as Record<string, unknown[]>)[message.params!.name] ?? []
          reply(message.id, queue.shift())
        } else if (message.method === "ui/notifications/size-changed") {
          sizes.push(message.params)
        } else if (message.method === "ui/update-model-context") {
          contexts.push(message.params)
          reply(message.id, {})
        } else if (message.method === "ui/open-link") {
          links.push(message.params)
          reply(message.id, {})
        } else if (message.id !== undefined) {
          reply(message.id, {})
        }
      })
      frame.srcdoc = view
    },
    { view, host: { ...host, sandbox } },
  )
  return page.frameLocator("iframe")
}

const answer = (page: Page, name: string, result: unknown) =>
  page.evaluate(({ name, result }) => {
    const answers = (window as unknown as { answers: Record<string, unknown[]> }).answers
    ;(answers[name] ??= []).push(result)
  }, { name, result })

const displayModes = (page: Page) => page.evaluate(() => (window as unknown as { displayModes: string[] }).displayModes)

const calls = (page: Page) => page.evaluate(() => (window as unknown as { calls: { name: string; arguments: Record<string, unknown> }[] }).calls)
const violations = (page: Page) => page.frames()[1].evaluate(() => (window as unknown as { violations: string[] }).violations)

/** Opens the editor and makes two edits: a word in emphasis, and the end of a list item. */
async function edit(page: Page) {
  const card = page.frameLocator("iframe")
  await card.getByRole("button", { name: "Edit" }).click()
  const editor = card.locator(".ProseMirror")
  await expect(editor).toBeVisible()
  // Embeds and other MDX show, and cannot be edited.
  await expect(card.locator("[data-fluid-object] svg")).toHaveCount(1)
  await expect(card.locator("[data-fluid-object]").filter({ hasText: '<Callout type="note">' })).toHaveCount(1)
  await expect(card.locator("[data-fluid-object] table")).toHaveCount(1)
  await editor.locator("em", { hasText: "soon" }).dblclick()
  await page.keyboard.type("today")
  await editor.locator("li").nth(1).click()
  await page.keyboard.press("End")
  await page.keyboard.type(" and more")
  await expect(card.getByRole("button", { name: "Save" })).toBeEnabled()
}

const EDITED = SOURCE.replace("*soon*", "*today*").replace("+ second item", "+ second item and more")

test("a note is edited in the chat card and saved with write_file, byte for byte", async ({ page }) => {
  const card = await openHost(page, { tools: true, theme: "light", result: shown(4, SOURCE) })
  await expect(card.getByText("Version 4 as rendered by the server.")).toBeVisible()
  await expect(card.getByText("v4", { exact: true })).toBeVisible()
  // The card shows the note with what it carries, and its fonts; the editor loads when Edit is pressed.
  expect(asked(page).filter((name) => !name.endsWith("latin"))).toEqual([])
  await edit(page)
  expect(asked(page)).toContain("editor")
  expect(asked(page)).not.toContain("frame")

  await answer(page, "write_file", { content: [{ type: "text", text: "{}" }], structuredContent: { status: "saved", changes: [{ op: "put", path: PATH, version: 5 }] } })
  await answer(page, "show_file", shown(5, EDITED))
  await card.getByRole("button", { name: "Save" }).click()

  await expect(card.getByText("Saved as v5.")).toBeVisible()
  await expect(card.getByText("Version 5 as rendered by the server.")).toBeVisible()
  await expect(card.getByText("v5", { exact: true })).toBeVisible()
  await expect(card.getByRole("button", { name: "Edit" })).toBeVisible()
  const [write, reload] = await calls(page)
  const { mutation_id, ...args } = write.arguments
  expect(write.name).toBe("write_file")
  // Only the edited words changed: every other byte of the note is as it was.
  expect(args).toEqual({ project_id: PROJECT, path: PATH, content: EDITED, base_version: 4 })
  expect(String(mutation_id)).toMatch(/^[0-9a-f-]{36}$/)
  expect(reload).toEqual({ name: "show_file", arguments: { project_id: PROJECT, path: PATH } })
  // The model hears about the edit on its next turn.
  const contexts = await page.evaluate(() => (window as unknown as { contexts: { content: { text: string }[] }[] }).contexts)
  expect(contexts.map((context) => context.content[0].text)).toEqual([
    `The user edited ${PATH} in the elaborat.ing card and saved it as version 5. Read it again before changing it.`,
  ])
  // The app's fonts load from elaborat.ing too, which the declared policy allows.
  const fonts = () => page.frames()[1].evaluate(() => [...document.fonts].map((font) => [font.family.replaceAll('"', ""), font.status]))
  await expect.poll(fonts).toEqual([
    ["Space Grotesk Variable", "loaded"],
    ["JetBrains Mono Variable", "loaded"],
    ["Excalifont", "loaded"],
  ])
  // Runs under the default policy: no eval, no requests.
  expect(await violations(page)).toEqual([])
  // A host that offers no full screen is not asked for it.
  expect(await displayModes(page)).toEqual([])
})

test("a note changed since the card loaded is not overwritten, and the latest can be loaded", async ({ page }) => {
  const card = await openHost(page, { tools: true, theme: "dark", result: shown(4, SOURCE) })
  await edit(page)
  await answer(page, "write_file", {
    content: [{ type: "text", text: "{}" }],
    structuredContent: { status: "conflict", conflicts: [{ path: PATH, base_version: 4, current: { version: 6, content: "# Changed" } }] },
  })
  await card.getByRole("button", { name: "Save" }).click()
  await expect(card.getByText("This note changed since it was loaded, so your edit was not saved.", { exact: false })).toBeVisible()
  await expect(card.getByRole("button", { name: "Save" })).toBeHidden()
  // The edit is still on screen until the latest is loaded.
  await expect(card.locator(".ProseMirror")).toContainText("today")

  await answer(page, "show_file", shown(6, "# Changed\n"))
  await card.getByRole("button", { name: "Load latest" }).click()
  await expect(card.getByText("Version 6 as rendered by the server.")).toBeVisible()
  await expect(card.getByText("v6", { exact: true })).toBeVisible()
  expect((await calls(page)).map((call) => [call.name, call.arguments.base_version])).toEqual([["write_file", 4], ["show_file", undefined]])
  const contexts = await page.evaluate(() => (window as unknown as { contexts: unknown[] }).contexts)
  expect(contexts).toEqual([])
})

test("where the host cannot call tools, the card stays read-only, keeps the app's fonts, and reports its size", async ({ page }) => {
  const card = await openHost(page, {
    tools: false,
    theme: "light",
    result: shown(4, SOURCE),
    styles: { variables: { "--font-sans": "Georgia, serif" } },
  })
  await expect(card.getByText("Version 4 as rendered by the server.")).toBeVisible()
  await expect(card.getByRole("link", { name: "Open in elaborat.ing" })).toBeVisible()
  await expect(card.getByRole("button", { name: "Edit" })).toBeHidden()
  // Outside ChatGPT, the host's fonts do not replace the app's.
  await expect(card.getByText("Launch plan")).toHaveCSS("font-family", /^"Space Grotesk Variable"/)
  // The palette's light panel, as the host asked.
  await expect(card.locator('[data-slot="chat-card"]')).toHaveCSS("background-color", "rgb(255, 255, 255)")
  const sizes = () => page.evaluate(() => (window as unknown as { sizes: { width: number; height: number }[] }).sizes)
  const width = await page.frames()[1].evaluate(() => window.innerWidth)
  await expect.poll(async () => (await sizes()).at(-1)?.width).toBe(width)
  expect((await sizes()).at(-1)!.height).toBeGreaterThan(200)
})

test("in ChatGPT the card is in the host's fonts, and loads only the drawings' font", async ({ page }) => {
  const card = await openHost(page, { tools: true, theme: "light", result: shown(4, SOURCE), chatgpt: true, styles: { variables: { "--font-sans": "Georgia, serif" } } })
  await expect(card.getByText("Launch plan")).toHaveCSS("font-family", /^Georgia/)
  await expect(card.getByText("v4", { exact: true })).toHaveCSS("font-family", /^ui-monospace/)
  const fonts = () => page.frames()[1].evaluate(() => [...document.fonts].map((font) => [font.family.replaceAll('"', ""), font.status]))
  await expect.poll(fonts).toEqual([["Excalifont", "loaded"]])
  expect(asked(page)).toEqual(["excalifont-latin"])
})

test("Edit asks the host for full screen where it offers it, and the card goes back inline when editing ends", async ({ page }) => {
  const card = await openHost(page, { tools: true, theme: "light", result: shown(4, SOURCE), modes: ["inline", "fullscreen"] })
  await card.getByRole("button", { name: "Edit" }).click()
  const offered = await page.evaluate(() => (window as unknown as { initialize: { appCapabilities: unknown } }).initialize.appCapabilities)
  expect(offered).toEqual({ availableDisplayModes: ["inline", "fullscreen"] })
  await expect(card.locator(".ProseMirror")).toBeVisible()
  expect(await displayModes(page)).toEqual(["fullscreen"])
  await expect(card.locator("html")).toHaveAttribute("data-display-mode", "fullscreen")
  // The card fills the view, with its buttons at the foot.
  const box = await card.locator('[data-slot="chat-card"]').boundingBox()
  expect(box!.height).toBeGreaterThan(890)
  await card.getByRole("button", { name: "Cancel" }).click()
  await expect.poll(() => displayModes(page)).toEqual(["fullscreen", "inline"])
  await expect(card.locator("html")).toHaveAttribute("data-display-mode", "inline")
})

/** A show_file result for a diagram whose canvas was drawn from older source. */
const staleDiagram = {
  content: [{ type: "text", text: "Showing flows/signup.d2 (version 3) to the user." }],
  structuredContent: {
    project_id: PROJECT,
    path: "flows/signup.d2",
    kind: "diagram",
    version: 3,
    updated_at: null,
    url: `https://elaborat.ing/projects/${PROJECT}/flows/signup.d2`,
    truncated: false,
    embeds: [{ kind: "diagram", path: "flows/signup.d2", url: `https://elaborat.ing/projects/${PROJECT}/flows/signup.d2`, status: "stale" }],
  },
  _meta: { "elaborat.ing/svg": { "flows/signup.d2": SVG } },
}

test("a diagram shows on the dotted canvas in dark mode, with a banner when its source changed since it was drawn", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 })
  const card = await openHost(page, { tools: true, theme: "dark", result: staleDiagram })
  await expect(card.getByRole("img", { name: "Diagram flows/signup.d2" })).toBeVisible()
  await expect(card.getByRole("status").filter({ hasText: "Its source changed after this was drawn." })).toBeVisible()
  await expect(card.getByText("v3", { exact: true })).toBeVisible()
  await expect(card.getByRole("button", { name: "Edit" })).toBeHidden()
  // The palette's dark panel, and the drawing through the dark filter.
  await expect(card.locator('[data-slot="chat-card"]')).toHaveCSS("background-color", "rgb(28, 29, 28)")
  await expect(card.locator(".card-art svg")).toHaveCSS("filter", /invert/)
  // Nothing runs past the phone's width.
  expect(await page.frames()[1].evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  expect(await violations(page)).toEqual([])
})

// Component previews: a note's built-in and workspace components, and a
// component file an agent is drafting, drawn in a frame nested in the card
// (sandbox="allow-scripts", so it cannot reach the card or the host's bridge)
// under the same default policy, which runs no code from strings.

const METRIC = [
  "export const componentMeta = { Metric: { props: { label: { type: 'string', default: 'Agents this week' }, value: { type: 'number', default: 128 } } } }",
  "",
  "export const Metric = ({ label, value }) => <div data-metric><span>{label}</span> <strong>{value}</strong></div>",
  "",
  "export function Broken() { throw new Error('Broken on purpose') }",
].join("\n")

// A component that tries to reach past its frame: the card's page, code from a string, a tool
// call through the card and the host, and a link it opens with no click.
const SNEAKY = [
  "export function Sneaky() {",
  "  let reach = 'blocked'",
  "  try { reach = window.parent.document.title || 'reached' } catch {}",
  "  let strings = 'blocked'",
  "  try { strings = new Function('return \\'ran\\'')() } catch {}",
  "  const call = { jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'write_file', arguments: { path: 'x' } } }",
  "  window.parent.postMessage(call, '*')",
  "  window.top.postMessage(call, '*')",
  "  const run = Number(/run:(\\d+)/.exec(document.scripts[0].textContent)[1])",
  "  window.parent.postMessage({ type: 'link', run, href: 'https://example.com/unasked' }, '*')",
  "  return <p>Parent page: {reach}. Code from strings: {strings}.</p>",
  "}",
].join("\n")

const COMPONENT_NOTE = [
  "---",
  "title: Launch plan",
  "---",
  "import { Metric, Broken } from 'workspace:components/metric.mdx'",
  "import { Sneaky } from 'workspace:components/sneaky.mdx'",
  "",
  "# Launch plan",
  "",
  "A new <Badge>beta</Badge> and [the docs](https://example.com/docs).",
  "",
  '<Callout tone="warn" title="Heads up">Built in, from the app.</Callout>',
  "",
  '<Metric label="Agents" value={128} />',
  "",
  "<Broken />",
  "",
  "<Sneaky />",
  "",
  "After the broken one.",
  "",
].join("\n")

/** show_file's result for a note with components, with the component files it imports. */
function withComponents(source: string, modules: Record<string, string>) {
  const result = shown(4, source)
  return { ...result, _meta: { ...result._meta, "elaborat.ing/components": { modules } } }
}

const preview = (page: Page, title: string) => page.frameLocator("iframe").frameLocator(`iframe[title="Preview of ${title}"]`)
const cardFrame = (page: Page) => page.frames()[1]
const previewFrame = (page: Page) => page.frames().find((frame) => frame.parentFrame() === cardFrame(page))!
const contexts = (page: Page) => page.evaluate(() => (window as unknown as { contexts: { content: { text: string }[] }[] }).contexts.map((context) => context.content[0].text))

for (const theme of ["light", "dark"] as const) {
  test(`a note's built-in and workspace components show in a sandboxed frame, and one that throws shows its error (${theme})`, async ({ page }) => {
    const card = await openHost(page, {
      tools: true,
      theme,
      result: withComponents(COMPONENT_NOTE, { "components/metric.mdx": METRIC, "components/sneaky.mdx": SNEAKY }),
    })
    const note = preview(page, PATH)
    await expect(note.getByRole("heading", { name: "Launch plan" })).toBeVisible()
    // Built in: the app's Badge and Callout. From the project: Metric, with the note's props.
    await expect(note.locator('[data-component="Badge"]', { hasText: "beta" })).toBeVisible()
    await expect(note.locator('aside[data-component="Callout"]')).toContainText("Built in, from the app.")
    await expect(note.locator("[data-metric]")).toHaveText("Agents 128")
    // The one that throws shows its error in its place, and the rest of the note carries on.
    await expect(note.getByRole("alert")).toHaveText("Broken could not be shown: Broken on purpose")
    await expect(note.getByText("After the broken one.")).toBeVisible()
    // The preview replaced the server's HTML, and the card is whole around it.
    await expect(card.getByText("Version 4 as rendered by the server.")).toBeHidden()
    await expect(card.getByText("v4", { exact: true })).toBeVisible()
    await expect(card.getByRole("button", { name: "Edit" })).toBeVisible()

    // The frame is an opaque origin with nothing but scripts, under the same policy: no code from
    // strings. The component could not reach the card's page, call a tool, or open a link on its own.
    await expect(card.locator(`iframe[title="Preview of ${PATH}"]`)).toHaveAttribute("sandbox", "allow-scripts")
    await expect(note.getByText("Parent page: blocked. Code from strings: blocked.")).toBeVisible()
    expect(await calls(page)).toEqual([])
    // A link the preview asks for opens only when the person says so in the card.
    const links = () => page.evaluate(() => (window as unknown as { links: unknown[] }).links)
    await expect(card.getByRole("status").filter({ hasText: "Open https://example.com/unasked?" })).toBeVisible()
    expect(await links()).toEqual([])
    await card.getByRole("button", { name: "Not now" }).click()
    await expect(card.getByText("Open https://example.com/unasked?")).toBeHidden()
    await note.getByRole("link", { name: "the docs" }).click()
    // The card asks beside the link, not under the whole preview.
    const docs = (await note.getByRole("link", { name: "the docs" }).boundingBox())!
    const asking = (await card.locator('[data-slot="link-prompt"]').boundingBox())!
    expect(Math.abs(asking.y - (docs.y + docs.height))).toBeLessThan(12)
    await card.getByRole("button", { name: "Open", exact: true }).click()
    await expect.poll(links).toEqual([{ url: "https://example.com/docs" }])

    // The compiler and the frame's runtime loaded for the preview; the charts' library did not.
    expect(asked(page)).toEqual(expect.arrayContaining(["compile", "frame"]))
    expect(asked(page)).not.toContain("documentCharts")
    // In the host's scheme: the frame's words take the card's colour, and the app's fonts load there too.
    const cardText = await card.locator("header p").first().evaluate((element) => getComputedStyle(element).color)
    await expect(note.getByRole("heading", { name: "Launch plan" })).toHaveCSS("color", cardText)
    expect(await previewFrame(page).evaluate(() => document.documentElement.dataset.scheme)).toBe(theme)
    const fonts = () => previewFrame(page).evaluate(() => [...document.fonts].map((font) => [font.family.replaceAll('"', ""), font.status]))
    await expect.poll(fonts).toContainEqual(["Space Grotesk Variable", "loaded"])
    expect(await violations(page)).toEqual([])
    // Nothing but a draft's preview tells the model about errors.
    expect(await contexts(page)).toEqual([])
  })

  test(`a draft component file shows each component with its sample props, and the model hears about the one that throws (${theme})`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 })
    const card = await openHost(page, {
      tools: true,
      theme,
      result: {
        content: [{ type: "text", text: "Showing a preview of the components in components/metric.mdx (a draft, not saved) to the user." }],
        structuredContent: {
          project_id: PROJECT,
          path: "components/metric.mdx",
          kind: "component",
          version: null,
          updated_at: null,
          url: `https://elaborat.ing/projects/${PROJECT}`,
          truncated: false,
          embeds: [],
          draft: true,
          component: null,
          props: null,
        },
        _meta: { "elaborat.ing/components": { modules: { "components/metric.mdx": METRIC } } },
      },
    })
    await expect(card.getByText("metric.mdx", { exact: true })).toBeVisible()
    await expect(card.getByText("draft", { exact: true })).toBeVisible()
    // A draft is no file yet: its link opens the project.
    await expect(card.getByRole("link", { name: "Open the project in elaborat.ing" })).toHaveAttribute("href", `https://elaborat.ing/projects/${PROJECT}`)
    const shownPreview = preview(page, "components/metric.mdx")
    // The componentMeta defaults, as the app's block picker inserts them.
    await expect(shownPreview.locator("[data-metric]")).toHaveText("Agents this week 128")
    // Each caption says the props it was drawn with.
    await expect(shownPreview.getByText('<Metric label="Agents this week" value={128} />')).toBeVisible()
    await expect(shownPreview.getByText("<Broken />")).toBeVisible()
    await expect(shownPreview.getByRole("alert")).toHaveText("Broken could not be shown: Broken on purpose")
    await expect(card.getByRole("button", { name: "Edit" })).toBeHidden()
    await expect.poll(() => contexts(page)).toEqual([
      "The preview of components/metric.mdx in the elaborat.ing card showed errors from its components. Broken: Broken on purpose",
    ])
    expect(await previewFrame(page).evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    expect(await cardFrame(page).evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    expect(await violations(page)).toEqual([])
  })
}

test("a preview that cannot be made leaves the note as the server rendered it, with the reason", async ({ page }) => {
  const card = await openHost(page, {
    tools: true,
    theme: "light",
    result: withComponents("import { Gone } from 'workspace:components/gone.mdx'\n\n# Launch plan\n\n<Gone />\n", {}),
  })
  await expect(card.getByRole("status").filter({ hasText: "The components in this note could not be shown here: No component file at components/gone.mdx." })).toBeVisible()
  await expect(card.getByText("Version 4 as rendered by the server.")).toBeVisible()
  await expect(card.locator("iframe")).toHaveCount(0)
  // Editing still works from there.
  await card.getByRole("button", { name: "Edit" }).click()
  await expect(card.locator(".ProseMirror")).toBeVisible()
})

test("a note from a shared project runs its custom components only when the person says so", async ({ page }) => {
  const shared = (source: string, modules: Record<string, string>) => {
    const result = withComponents(source, modules)
    const components = { modules, editors: { "components/metric.mdx": "Ana" } }
    return { ...result, structuredContent: { ...result.structuredContent, shared: true }, _meta: { ...result._meta, "elaborat.ing/components": components } }
  }
  const note = "import { Metric } from 'workspace:components/metric.mdx'\n\n# Launch plan\n\n<Metric label=\"Agents\" value={128} />\n"
  const card = await openHost(page, { tools: true, theme: "light", result: shared(note, { "components/metric.mdx": METRIC }) })
  const asking = card.getByRole("status").filter({ hasText: "This note from a shared project runs custom code." })
  await expect(asking).toBeVisible()
  // The files the code comes from, and who last changed them.
  await expect(asking.getByRole("list", { name: "Files with custom code" }).getByRole("listitem")).toHaveText(["components/metric.mdx, last changed by Ana"])
  await expect(asking).toContainText("It runs in an isolated frame, with no network and no access to your account.")
  // Until then the card shows the server's HTML, and no frame runs the code.
  await expect(card.getByText("Version 4 as rendered by the server.")).toBeVisible()
  await expect(card.locator("iframe")).toHaveCount(0)
  await card.getByRole("button", { name: "Run code" }).click()
  await expect(preview(page, PATH).locator("[data-metric]")).toHaveText("Agents 128")
  await expect(asking).toBeHidden()
})

const sharedComponent = (draft: boolean) => ({
  content: [{ type: "text", text: "Showing a preview of Metric from components/metric.mdx to the user." }],
  structuredContent: {
    project_id: PROJECT,
    path: "components/metric.mdx",
    kind: "component",
    version: draft ? null : 2,
    updated_at: null,
    url: `https://elaborat.ing/projects/${PROJECT}/components/metric.mdx`,
    truncated: false,
    embeds: [],
    draft,
    component: "Metric",
    props: null,
    shared: true,
  },
  _meta: { "elaborat.ing/components": { modules: { "components/metric.mdx": METRIC }, editors: { "components/metric.mdx": "Ana" } } },
})

test("a saved component file from a shared project runs only when the person says so", async ({ page }) => {
  const card = await openHost(page, { tools: true, theme: "dark", result: sharedComponent(false) })
  const asking = card.getByRole("status").filter({ hasText: "These components are in a shared project and run custom code." })
  await expect(asking.getByRole("listitem")).toHaveText(["components/metric.mdx, last changed by Ana"])
  await expect(card.locator("iframe")).toHaveCount(0)
  await card.getByRole("button", { name: "Run code" }).click()
  await expect(preview(page, "components/metric.mdx").locator("[data-metric]")).toHaveText("Agents this week 128")
  await expect(asking).toBeHidden()
  expect(await violations(page)).toEqual([])
})

test("an agent's draft component from a shared project that imports nothing runs at once", async ({ page }) => {
  const card = await openHost(page, { tools: true, theme: "light", result: sharedComponent(true) })
  await expect(preview(page, "components/metric.mdx").locator("[data-metric]")).toHaveText("Agents this week 128")
  await expect(card.getByRole("button", { name: "Run code" })).toHaveCount(0)
})

test("a component file whose code does not compile is a problem in the card, and the model hears why", async ({ page }) => {
  const card = await openHost(page, {
    tools: false,
    theme: "dark",
    result: {
      content: [{ type: "text", text: "Showing a preview of Metric from components/metric.mdx (version 2) to the user." }],
      structuredContent: {
        project_id: PROJECT,
        path: "components/metric.mdx",
        kind: "component",
        version: 2,
        updated_at: null,
        url: `https://elaborat.ing/projects/${PROJECT}/components/metric.mdx`,
        truncated: false,
        embeds: [],
        draft: false,
        component: "Metric",
        props: { label: "Q3" },
      },
      _meta: { "elaborat.ing/components": { modules: { "components/metric.mdx": "export const Metric = ( => <div />\n" } } },
    },
  })
  // In plain words, with the line.
  await expect(card.getByRole("alert")).toHaveText(/^This component could not be shown: An import or export is not valid JavaScript: .+ \(line 1\)$/)
  await expect(card.getByText("v2", { exact: true })).toBeVisible()
  await expect.poll(() => contexts(page)).toHaveLength(1)
  expect((await contexts(page))[0]).toMatch(/^The preview of components\/metric\.mdx in the elaborat\.ing card failed: /)
})

test("a chart in a note draws in the preview, with the charts' library loaded for it", async ({ page }) => {
  const note = [
    "# Visitors",
    "",
    '<ChartContainer config={{ visitors: { label: "Visitors", color: "var(--chart-1)" } }} aria-label="Monthly visitors" description="Visitors grew from 120 to 180.">',
    '  <BarChart accessibilityLayer data={[{ month: "Jan", visitors: 120 }, { month: "Feb", visitors: 160 }, { month: "Mar", visitors: 180 }]}>',
    '    <XAxis dataKey="month" />',
    '    <Bar dataKey="visitors" fill="var(--color-visitors)" isAnimationActive={false} />',
    "  </BarChart>",
    "</ChartContainer>",
    "",
  ].join("\n")
  const card = await openHost(page, { tools: true, theme: "dark", result: withComponents(note, {}) })
  const shownPreview = preview(page, PATH)
  await expect(shownPreview.getByRole("heading", { name: "Visitors" })).toBeVisible()
  // Recharts draws the bars, in place of the box that says charts show in elaborat.ing.
  await expect(shownPreview.locator(".recharts-bar-rectangle")).toHaveCount(3)
  await expect(shownPreview.getByText("Charts show in elaborat.ing.")).toHaveCount(0)
  await expect(shownPreview.getByRole("group", { name: "Monthly visitors" }).getByText("Jan")).toBeVisible()
  expect(asked(page)).toContain("documentCharts")
  await expect(card.getByText("Version 4 as rendered by the server.")).toBeHidden()
  expect(await violations(page)).toEqual([])
})

for (const policy of ["default", "default-said"] as const) {
  test(`where the host allows only the default policy, the card shows the server's HTML, read-only, and says why (${policy === "default" ? "found on Edit" : "said up front"})`, async ({ page }) => {
    const card = await openHost(page, { tools: true, theme: "light", policy, result: withComponents(COMPONENT_NOTE, { "components/metric.mdx": METRIC, "components/sneaky.mdx": SNEAKY }) })
    // The note as the server rendered it, and why its components are not shown.
    await expect(card.getByText("Version 4 as rendered by the server.")).toBeVisible()
    await expect(card.getByRole("status").filter({ hasText: "The components in this note could not be shown here: the preview could not load from elaborat.ing." })).toBeVisible()
    await expect(card.locator("iframe")).toHaveCount(0)
    const editing = card.getByText("This chat did not let the editor load from elaborat.ing. Open the note there to change it.")
    if (policy === "default") {
      // A host that does not say finds out when Edit is pressed.
      await card.getByRole("button", { name: "Edit" }).click()
      await expect(editing).toBeVisible()
      expect(await violations(page)).toContainEqual(expect.stringMatching(/^script-src(-elem)? https:\/\/elaborat\.ing\/chat-card\//))
    } else {
      await expect(editing).toBeVisible()
      // A host that says so is not asked at all.
      expect(await violations(page)).toEqual([])
    }
    await expect(card.getByRole("button", { name: "Edit" })).toHaveCount(0)
    await expect(card.getByText("Version 4 as rendered by the server.")).toBeVisible()
    await expect(card.getByRole("link", { name: "Open in elaborat.ing" })).toBeVisible()
    expect(asked(page)).toEqual([])
  })
}

// create_and_show: a new file shown while the agent writes it. The stand-in
// host sends the input so far, cut anywhere, as Claude does, then the input
// and the result; a host that sends no partial input gets the input alone.

const FLOW = "art/flow.excalidraw"
const FLOW_URL = `https://elaborat.ing/projects/${PROJECT}/${FLOW}`
const shape = { angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "hachure", strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100, roundness: null }
/** A drawing as an agent writes it: shapes, their labels, then the arrows. */
const FLOW_SCENE = JSON.stringify(
  {
    type: "excalidraw",
    version: 2,
    elements: [
      { ...shape, id: "a", type: "rectangle", x: 0, y: 0, width: 160, height: 70, seed: 1, backgroundColor: "#a5d8ff" },
      { ...shape, id: "a-label", type: "text", x: 30, y: 22, width: 100, height: 25, seed: 2, text: 'Write "it"', fontSize: 20, fontFamily: 5, textAlign: "center", containerId: "a" },
      { ...shape, id: "b", type: "ellipse", x: 280, y: -10, width: 150, height: 90, seed: 3 },
      { ...shape, id: "b-label", type: "text", x: 320, y: 22, width: 70, height: 25, seed: 4, text: "Ship } it", fontSize: 20, fontFamily: 5, textAlign: "center", containerId: "b" },
      { ...shape, id: "c", type: "diamond", x: 120, y: 160, width: 120, height: 90, seed: 5, backgroundColor: "#ffec99", fillStyle: "solid" },
      { ...shape, id: "ab", type: "arrow", x: 160, y: 35, width: 120, height: 0, seed: 6, points: [[0, 0], [120, 0]], endArrowhead: "arrow" },
      { ...shape, id: "bc", type: "arrow", x: 330, y: 80, width: 100, height: 110, seed: 7, points: [[0, 0], [-90, 110]], endArrowhead: "arrow", strokeStyle: "dashed" },
    ],
    appState: { viewBackgroundColor: "#ffffff" },
  },
  null,
  2,
)
const PLAN = ["# Launch plan", "", "Ship it *soon*, with care.", "", "- first item", "- second item", "", '<Drawing src="art/flow.excalidraw" />', "", "## Next", "", "Tell the team."].join("\n")

/** create_and_show's result: show_file's, for the new file. */
function created(path: string, kind: "note" | "drawing", meta: Record<string, unknown>) {
  const url = `https://elaborat.ing/projects/${PROJECT}/${path}`
  return {
    content: [{ type: "text", text: `Created ${path} (version 1) and showed it to the user.` }],
    structuredContent: { project_id: PROJECT, path, kind, version: 1, updated_at: null, url, truncated: false, embeds: kind === "drawing" ? [{ kind, path, url, status: "drawn" }] : [] },
    _meta: meta,
  }
}
const FLOW_RESULT = created(FLOW, "drawing", { "elaborat.ing/svg": { [FLOW]: SVG } })

const send = (page: Page, method: string, params: unknown) =>
  page.evaluate(({ method, params }) => (window as unknown as { send: (method: string, params: unknown) => void }).send(method, params), { method, params })
const input = (path: string, content: string) => ({ arguments: { project_id: PROJECT, path, content } })

/** Waits for the view to be ready, then sends the file in pieces cut at the given offsets, a little apart. */
async function writeIn(page: Page, path: string, content: string, cuts: number[], each?: () => Promise<void>) {
  await expect.poll(() => page.evaluate(() => (window as unknown as { ready?: boolean }).ready)).toBe(true)
  for (const cut of [...cuts, content.length]) {
    await send(page, "ui/notifications/tool-input-partial", input(path, content.slice(0, cut)))
    await page.waitForTimeout(80)
    await each?.()
  }
}

/** Offsets that cut the file anywhere: inside strings, escapes, numbers and keys. */
const cutsOf = (content: string, pieces: number) => Array.from({ length: pieces }, (_, index) => Math.floor(((index + 1) * content.length) / (pieces + 1)) + ((index * 7) % 13))
const liveShapes = (page: Page) => cardFrame(page).evaluate(() => document.querySelectorAll(".live-svg > g").length)

test("a new drawing draws in as the agent writes it, then the saved card takes its place", async ({ page }) => {
  const card = await openHost(page, { tools: true, theme: "light", result: null, manual: true })
  const counts: number[] = []
  await writeIn(page, FLOW, FLOW_SCENE, cutsOf(FLOW_SCENE, 9), async () => {
    counts.push(await liveShapes(page))
  })
  // Shapes only ever come in, never go.
  expect(counts).toEqual([...counts].sort((a, b) => a - b))
  await expect.poll(() => liveShapes(page)).toBe(7)
  expect(counts.at(-1)).toBeGreaterThan(0)
  await expect(card.getByRole("status").filter({ hasText: `Drawing ${FLOW}` })).toBeVisible()
  await expect(card.locator('[data-slot="chat-card"]')).toHaveAttribute("aria-busy", "true")
  expect(asked(page)).toContain("live")

  await send(page, "ui/notifications/tool-input", input(FLOW, FLOW_SCENE))
  await send(page, "ui/notifications/tool-result", FLOW_RESULT)
  await expect(card.getByRole("img", { name: `Drawing ${FLOW}` })).toBeVisible()
  await expect(card.getByRole("link", { name: "Open in elaborat.ing" })).toHaveAttribute("href", FLOW_URL)
  await expect(card.locator(".live-svg")).toHaveCount(0)
  await expect(card.locator('[data-slot="chat-card"]')).not.toHaveAttribute("aria-busy", "true")
  expect(await violations(page)).toEqual([])
})

test("a new note writes in, its heading before it is saved, then the saved card takes its place", async ({ page }) => {
  const card = await openHost(page, { tools: true, theme: "dark", result: null, manual: true })
  await writeIn(page, "notes/launch.mdx", PLAN, cutsOf(PLAN, 6))
  await expect(card.locator("[data-live-content] h1")).toHaveText("Launch plan")
  await expect(card.locator("[data-live-content] .live-embed")).toHaveText(`Drawing ${FLOW}`)
  await expect(card.getByRole("status").filter({ hasText: "Writing notes/launch.mdx" })).toBeVisible()

  await send(page, "ui/notifications/tool-input", input("notes/launch.mdx", PLAN))
  await send(page, "ui/notifications/tool-result", created("notes/launch.mdx", "note", { "elaborat.ing/html": "<h1>Launch plan</h1><p>As saved.</p>", "elaborat.ing/source": PLAN }))
  await expect(card.getByText("As saved.")).toBeVisible()
  await expect(card.locator("[data-live-content]")).toHaveCount(0)
})

test("input and result that come together, as in a conversation opened again, show the saved card at once", async ({ page }) => {
  const card = await openHost(page, { tools: true, theme: "light", result: null, manual: true })
  await expect.poll(() => page.evaluate(() => (window as unknown as { ready?: boolean }).ready)).toBe(true)
  await page.evaluate(
    ({ input, result }) => {
      const { send } = window as unknown as { send: (method: string, params: unknown) => void }
      send("ui/notifications/tool-input", input)
      send("ui/notifications/tool-result", result)
    },
    { input: input(FLOW, FLOW_SCENE), result: FLOW_RESULT },
  )
  await expect(card.getByRole("img", { name: `Drawing ${FLOW}` })).toBeVisible()
  await page.waitForTimeout(300)
  // It never went live: the live view was not even loaded.
  expect(asked(page)).not.toContain("live")
})

test("with no partial input, the input draws in while the tool runs", async ({ page }) => {
  const card = await openHost(page, { tools: true, theme: "light", result: null, manual: true })
  await expect.poll(() => page.evaluate(() => (window as unknown as { ready?: boolean }).ready)).toBe(true)
  await send(page, "ui/notifications/tool-input", input(FLOW, FLOW_SCENE))
  await expect.poll(() => liveShapes(page)).toBe(7)
  await send(page, "ui/notifications/tool-result", FLOW_RESULT)
  await expect(card.getByRole("img", { name: `Drawing ${FLOW}` })).toBeVisible()
})

test("where the host does not allow the live view, the card shows its skeleton, then the saved card", async ({ page }) => {
  const card = await openHost(page, { tools: true, theme: "light", result: null, manual: true, policy: "default-said" })
  await writeIn(page, FLOW, FLOW_SCENE, cutsOf(FLOW_SCENE, 3))
  await expect(card.locator('[data-slot="chat-card"]')).toHaveAttribute("aria-busy", "true")
  await expect(card.locator('[data-slot="skeleton"]').first()).toBeVisible()
  await expect(card.locator(".live-svg")).toHaveCount(0)
  await send(page, "ui/notifications/tool-input", input(FLOW, FLOW_SCENE))
  await send(page, "ui/notifications/tool-result", FLOW_RESULT)
  await expect(card.getByRole("img", { name: `Drawing ${FLOW}` })).toBeVisible()
  expect(asked(page)).toEqual([])
  expect(await violations(page)).toEqual([])
})

test("a drawing that could not be saved leaves nothing of it on screen, only why", async ({ page }) => {
  const card = await openHost(page, { tools: true, theme: "light", result: null, manual: true })
  await writeIn(page, FLOW, FLOW_SCENE, cutsOf(FLOW_SCENE, 4))
  await expect.poll(() => liveShapes(page)).toBeGreaterThan(0)
  const message = `A file already exists at ${FLOW}. Nothing was saved. To change it, read it and use write_file with base_version.`
  await send(page, "ui/notifications/tool-input", input(FLOW, FLOW_SCENE))
  await send(page, "ui/notifications/tool-result", { isError: true, content: [{ type: "text", text: message }] })
  await expect(card.getByText(message)).toBeVisible()
  await expect(card.locator(".live-svg")).toHaveCount(0)
  await expect(card.getByText("This file could not be shown")).toBeVisible()
})

test("with reduced motion, a new drawing's shapes appear as they come, with nothing animated", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  const card = await openHost(page, { tools: true, theme: "light", result: null, manual: true })
  await writeIn(page, FLOW, FLOW_SCENE, cutsOf(FLOW_SCENE, 5))
  await expect.poll(() => liveShapes(page)).toBe(7)
  expect(await cardFrame(page).evaluate(() => document.getAnimations().length)).toBe(0)
  await send(page, "ui/notifications/tool-input", input(FLOW, FLOW_SCENE))
  await send(page, "ui/notifications/tool-result", FLOW_RESULT)
  await expect(card.getByRole("img", { name: `Drawing ${FLOW}` })).toBeVisible()
})
