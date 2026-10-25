import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { expect, test, type FrameLocator, type Page } from "./fixtures.ts"
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
// The declared policy in a host that also allows code from strings (and so
// WebAssembly) and workers from blob: URLs, as ChatGPT's view does: there the
// card draws D2 diagrams itself. D2's engine is WebAssembly, and it lays a
// diagram out by running ELK's JavaScript from strings.
const EVAL_CSP = `${DECLARED_CSP.replace("script-src 'self' 'unsafe-inline'", "script-src 'self' 'unsafe-inline' 'unsafe-eval'")}; worker-src blob:`

/**
 * The host's policy for the view: the one it declares, that one with code
 * from strings and blob: workers allowed, the default one from a host that
 * does not say, or the default one from a host that says in
 * `hostCapabilities.sandbox.csp` that it allows no resource origins.
 */
type Policy = "declared" | "eval" | "default" | "default-said"
/**
 * `chatgpt`: the host puts window.openai in the frame, as ChatGPT does.
 * `modes`: the display modes the host offers (`availableDisplayModes`).
 * `manual`: the host sends nothing once the view is ready; the test sends
 * the tool's input and result with `send`.
 * `dropsCallMeta`: the host leaves `_meta` out of the results of the card's
 * own tool calls, as a host may.
 * `silent`: the host never answers the card's tool calls.
 */
type Host = {
  tools: boolean
  theme: "light" | "dark"
  result: unknown
  styles?: unknown
  policy?: Policy
  chatgpt?: boolean
  modes?: string[]
  manual?: boolean
  dropsCallMeta?: boolean
  silent?: boolean
}

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
  const csp = policy === "declared" ? DECLARED_CSP : policy === "eval" ? EVAL_CSP : DEFAULT_CSP
  const declared = policy === "declared" || policy === "eval"
  const sandbox = declared ? { csp: { resourceDomains: [APP] } } : policy === "default-said" ? { csp: {} } : undefined
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
          if (host.silent) return
          const queue = (state.answers as Record<string, Record<string, unknown>[]>)[message.params!.name] ?? []
          const result = queue.shift()
          if (host.dropsCallMeta) delete result?._meta
          reply(message.id, result)
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

test("where the host leaves _meta out of the card's calls, a saved note goes on from what was saved, never the text the card first showed", async ({ page }) => {
  const card = await openHost(page, { tools: true, theme: "light", result: shown(4, SOURCE), chatgpt: true, dropsCallMeta: true })
  // As in ChatGPT, its globals keep the _meta of the result that showed the card.
  await page.frames()[1].evaluate((meta) => {
    ;(window as unknown as { openai: Record<string, unknown> }).openai.toolResponseMetadata = meta
  }, shown(4, SOURCE)._meta)
  await expect(card.getByText("Version 4 as rendered by the server.")).toBeVisible()
  await edit(page)
  await answer(page, "write_file", { content: [{ type: "text", text: "{}" }], structuredContent: { status: "saved", changes: [{ op: "put", path: PATH, version: 5 }] } })
  await answer(page, "show_file", shown(5, EDITED))
  await card.getByRole("button", { name: "Save" }).click()
  await expect(card.getByText("Saved as v5.")).toBeVisible()
  // The reload came back without the note's text: the card keeps the edit as saved, not version 4's text.
  await expect(card.getByText("Version 4 as rendered by the server.")).toHaveCount(0)
  await expect(card.locator(".ProseMirror em", { hasText: "today" })).toBeVisible()
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

const COPY_SAMPLES = [
  ["cpp", '#include <iostream>\n// [!code highlight:2]\nint main() {\n\tstd::cout << "<button>& code</button>"; // [!code focus]\n  return 0; // [!code ++]\n}\n\n'],
  ["unlisted-copy-language", "  Keep these spaces.  \n\n\tliteral <tag> & {expression}"],
  ["", "first\n\n  second\n\tthird"],
] as const
const COPY_NOTE = `# Copy code\n\n${COPY_SAMPLES.map(([language, code]) => `\`\`\`${language}\n${code}\n\`\`\``).join("\n\n")}\n`

function copyNote() {
  const result = shown(4, COPY_NOTE)
  const escape = (code: string) => code.replace(/[&<>]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[character]!)
  return {
    ...result,
    structuredContent: { ...result.structuredContent, embeds: [] },
    _meta: {
      ...result._meta,
      "elaborat.ing/html": `<h1>Copy code</h1>${COPY_SAMPLES.map(([language, code]) => `<pre><code${language ? ` class="language-${language}"` : ""}>${escape(code)}\n</code></pre>`).join("")}`,
    },
  }
}

/** Observe what the card asks to copy, independently of a host's clipboard policy. */
async function cardClipboard(page: Page, reject = false) {
  await page.frames()[1].evaluate((refused) => {
    const state = window as unknown as { copiedCode: string[]; refuseCopy: boolean }
    state.copiedCode = []
    state.refuseCopy = refused
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          state.copiedCode.push(text)
          if (state.refuseCopy) throw new DOMException("Clipboard permission refused", "NotAllowedError")
        },
      },
    })
  }, reject)
}
const cardCopied = (page: Page) => page.frames()[1].evaluate(() => (window as unknown as { copiedCode: string[] }).copiedCode)

for (const policy of ["default", "declared"] as const) {
  test(`a read-only card copies exact ${policy === "default" ? "plain" : "highlighted"} code, including annotations and whitespace`, async ({ page }) => {
    const card = await openHost(page, { tools: false, theme: "light", policy, result: copyNote() })
    await expect(card.locator(".document-code")).toHaveCount(COPY_SAMPLES.length)
    await cardClipboard(page)
    if (policy === "declared") {
      await expect(card.locator('[data-code-language="cpp"] .shiki')).toBeVisible()
      await expect(card.locator('[data-code-language="cpp"] .shiki')).not.toContainText("[!code")
    } else await expect(card.locator(".shiki")).toHaveCount(0)
    for (let index = 0; index < COPY_SAMPLES.length; index++) {
      const block = card.locator(".document-code").nth(index)
      await block.getByRole("button", { name: "Copy code", exact: true }).focus()
      await page.keyboard.press("Enter")
      await expect(block.getByRole("status")).toHaveText("Copied")
      await expect.poll(() => cardCopied(page)).toEqual(COPY_SAMPLES.slice(0, index + 1).map(([, code]) => code))
    }
    await expect(card.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0)
    expect(await calls(page)).toEqual([])
    if (policy === "default") {
      // This host never advertised resource policy, so the card attempts its
      // usual fonts and highlighter and their existing CSP failures stay plain.
      expect(await violations(page)).toEqual(expect.arrayContaining([
        expect.stringMatching(/^font-src https:\/\/elaborat\.ing\/chat-card\/space-grotesk-latin-[\w-]{8}\.woff2$/),
        expect.stringMatching(/^font-src https:\/\/elaborat\.ing\/chat-card\/jetbrains-mono-latin-[\w-]{8}\.woff2$/),
        expect.stringMatching(/^font-src https:\/\/elaborat\.ing\/chat-card\/excalifont-latin-[\w-]{8}\.woff2$/),
        expect.stringMatching(/^script-src-elem https:\/\/elaborat\.ing\/chat-card\/highlight-[\w-]{8}\.js$/),
      ]))
      expect(await violations(page)).toHaveLength(4)
    } else expect(await violations(page)).toEqual([])
  })
}

test("a refused chat-card copy reports failure and can retry without changing the note", async ({ page }) => {
  const card = await openHost(page, { tools: true, theme: "light", result: copyNote() })
  await expect(card.locator(".document-code")).toHaveCount(COPY_SAMPLES.length)
  await cardClipboard(page, true)
  const block = card.locator(".document-code").first()
  await block.getByRole("button", { name: "Copy code", exact: true }).click()
  await expect(block.getByRole("status")).toContainText("Could not copy")
  await expect(block.getByRole("button", { name: "Copy code", exact: true })).toBeEnabled()
  await page.frames()[1].evaluate(() => { (window as unknown as { refuseCopy: boolean }).refuseCopy = false })
  await block.getByRole("button", { name: "Copy code", exact: true }).click()
  await expect(block.getByRole("status")).toHaveText("Copied")
  expect(await cardCopied(page)).toEqual([COPY_SAMPLES[0][1], COPY_SAMPLES[0][1]])
  await card.getByRole("button", { name: "Edit", exact: true }).click()
  await expect(card.locator(".ProseMirror .document-code")).toHaveCount(COPY_SAMPLES.length)
  const editingBlock = card.locator(".ProseMirror .document-code").first()
  await editingBlock.getByRole("button", { name: "Copy code", exact: true }).click()
  await expect(editingBlock.getByRole("status")).toHaveText("Copied")
  expect(await cardCopied(page)).toEqual([COPY_SAMPLES[0][1], COPY_SAMPLES[0][1], COPY_SAMPLES[0][1]])
  await expect(card.getByRole("button", { name: "Save", exact: true })).toBeDisabled()
  expect(await calls(page)).toEqual([])
})

test("selecting part of code in the editable card keeps its scroll position and leaves the note unchanged", async ({ page }) => {
  const prefix = Array.from({ length: 35 }, (_, index) => `Paragraph ${index + 1} before the code.`).join("\n\n")
  const suffix = Array.from({ length: 20 }, (_, index) => `Paragraph ${index + 1} after the code.`).join("\n\n")
  const source = `# Code selection\n\n${prefix}\n\n\`\`\`cpp\nint selectionTarget = 42;\nreturn selectionTarget;\n\`\`\`\n\n\`\`\`unknown-selection-language\nKeep partialSelection exactly as written.\n\`\`\`\n\n${suffix}\n`
  const card = await openHost(page, { tools: true, theme: "light", result: shown(4, source) })
  await card.getByRole("button", { name: "Edit", exact: true }).click()
  const editor = card.locator(".ProseMirror")
  await expect(editor).toBeVisible()
  await expect(editor.locator('[data-code-language="cpp"] .shiki code')).toContainText("selectionTarget")

  for (const [language, word] of [["cpp", "selectionTarget"], ["unknown-selection-language", "partialSelection"]]) {
    const block = editor.locator(`[data-code-language="${language}"]`)
    const code = block.locator("pre code")
    await code.evaluate((element) => element.scrollIntoView({ block: "center" }))
    const before = await page.frames()[1].evaluate(() => scrollY)
    expect(before).toBeGreaterThan(400)
    const points = await code.evaluate((element, selected) => {
      const offset = element.textContent!.indexOf(selected)
      if (offset < 0) throw new Error("Selection text was not rendered")
      const point = (index: number) => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
        let remaining = index
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (remaining <= node.textContent!.length) {
            const range = document.createRange()
            range.setStart(node, remaining)
            range.collapse(true)
            const rect = range.getBoundingClientRect()
            return { x: rect.x, y: rect.y + rect.height / 2 }
          }
          remaining -= node.textContent!.length
        }
        throw new Error("Selection position was not rendered")
      }
      return { from: point(offset), to: point(offset + selected.length) }
    }, word)
    const frame = (await page.locator("iframe").boundingBox())!
    await page.mouse.move(frame.x + points.from.x, frame.y + points.from.y)
    await page.mouse.down()
    await page.mouse.move(frame.x + points.to.x, frame.y + points.to.y, { steps: 12 })
    await page.mouse.up()
    await expect.poll(() => page.frames()[1].evaluate(() => getSelection()?.toString())).toBe(word)
    expect(Math.abs((await page.frames()[1].evaluate(() => scrollY)) - before)).toBeLessThan(2)
    await expect(block.locator("textarea")).toHaveCount(0)
  }
  await expect(card.getByRole("button", { name: "Save", exact: true })).toBeDisabled()
  expect(await calls(page)).toEqual([])
  expect(await violations(page)).toEqual([])
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

// Drawings and diagrams that did not fit in show_file's result, which keeps
// its _meta small (fileView.ts MAX_META_CHARS), come deferred: the card loads
// each with card_embed, one at a time, where the host lets it call tools.

const LATER = "art/later.excalidraw"
const GONE = "art/gone.excalidraw"
const CIRCLE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40" width="120" height="40"><circle cx="60" cy="20" r="16" fill="none" stroke="#1e1e1e"/></svg>'
const NOT_LOADED = "Open it in elaborat.ing to see it."

/** show_file's result for the note with one drawing drawn and two that did not fit. */
const DEFERRED_NOTE = (() => {
  const embed = (path: string, status: string) => ({ kind: "drawing", path, url: `https://elaborat.ing/projects/${PROJECT}/${path}`, status })
  const note = shown(4, SOURCE)
  return {
    ...note,
    structuredContent: { ...note.structuredContent, embeds: [embed("art/flow.excalidraw", "drawn"), embed(LATER, "deferred"), embed(GONE, "deferred")] },
    _meta: { ...note._meta, "elaborat.ing/html": `<h1>Launch plan</h1>${[0, 1, 2].map((index) => `<figure class="embed" data-embed="${index}"></figure>`).join("")}` },
  }
})()

/** card_embed's result for a drawing, as the card loads one that was deferred: all of it in structuredContent. */
const embedSent = (path: string, svg: string) => ({
  content: [{ type: "text", text: `Sent ${path} to the card that shows it.` }],
  structuredContent: { path, status: "drawn", svg },
})

test("a drawing that did not fit in the result is loaded with card_embed and drawn where its link was, from a host that leaves _meta out, and one that does not load keeps its link", async ({ page }) => {
  const card = await openHost(page, { tools: true, theme: "light", result: null, manual: true, dropsCallMeta: true })
  await expect.poll(() => page.evaluate(() => (window as unknown as { ready?: boolean }).ready)).toBe(true)
  await answer(page, "card_embed", embedSent(LATER, CIRCLE))
  await answer(page, "card_embed", { isError: true, content: [{ type: "text", text: `No file at ${GONE} in this project.` }] })
  await send(page, "ui/notifications/tool-result", DEFERRED_NOTE)
  await expect(card.getByRole("img", { name: `Drawing ${LATER}` }).locator("circle")).toHaveCount(1)
  await expect(card.getByRole("img", { name: "Drawing art/flow.excalidraw" })).toBeVisible()
  // The one whose call failed keeps its link.
  await expect(card.getByRole("figure").filter({ hasText: GONE })).toContainText(NOT_LOADED)
  await expect(card.getByRole("link", { name: GONE })).toHaveAttribute("href", `https://elaborat.ing/projects/${PROJECT}/${GONE}`)
  await expect(card.locator('[data-slot="chat-card"]')).not.toHaveAttribute("aria-busy", "true")
  // One call for each, in the note's order, for its path in the same project.
  expect(await calls(page)).toEqual([
    { name: "card_embed", arguments: { project_id: PROJECT, path: LATER } },
    { name: "card_embed", arguments: { project_id: PROJECT, path: GONE } },
  ])
  expect(await violations(page)).toEqual([])

  // A host that does not let the card call tools gets the links.
  const readOnly = await openHost(page, { tools: false, theme: "light", result: DEFERRED_NOTE })
  await expect(readOnly.getByText(NOT_LOADED)).toHaveCount(2)
  await expect(readOnly.getByRole("img", { name: "Drawing art/flow.excalidraw" })).toBeVisible()
  expect(await calls(page)).toEqual([])
})

test("drawings that did not fit in the result all keep their links once the host has not answered the card's first call for 20 s", async ({ page }) => {
  await page.clock.install()
  const card = await openHost(page, { tools: true, theme: "light", result: DEFERRED_NOTE, silent: true })
  const [later, gone] = [LATER, GONE].map((path) => card.getByRole("figure").filter({ hasText: path }))
  await expect(later).toContainText("Loading it")
  await expect(gone).toContainText("Loading it")
  await page.clock.fastForward(15_000)
  await expect(later).toContainText("Loading it")
  await page.clock.fastForward(5_000)
  // The host stopped answering: the next one shows its link at once, with no call that would wait 20 s more.
  await expect(later).toContainText(NOT_LOADED)
  await expect(gone).toContainText(NOT_LOADED)
  await expect(card.locator('[data-slot="chat-card"]')).not.toHaveAttribute("aria-busy", "true")
  expect((await calls(page)).map((call) => call.arguments.path)).toEqual([LATER])
})

// D2 diagrams the app has not drawn from their source yet: a new one, with no
// canvas, or one whose source changed since its canvas was saved. The server
// sends what each is drawn from, and the card lays it out with the app's D2
// engine, in a worker of its own, where the host allows code from strings and
// workers from blob: URLs, as ChatGPT's view does.

const SIGN_IN = "flows/sign-in.d2"
const SIGN_IN_URL = `https://elaborat.ing/projects/${PROJECT}/${SIGN_IN}`
/**
 * A diagram as the app saves it once opened (made with projectDiagramArtifact,
 * diagramSidecarText and saveDrawingFile), with Projects and its label then
 * moved by hand, 40 right and 160 down: its source, canvas and layout record.
 */
const SAVED_DIAGRAM = JSON.parse(readFileSync(path.join(import.meta.dirname, "chat-card-diagram.json"), "utf8")) as { source: string; canvas: string; layout: string }
const SIGN_IN_D2 = SAVED_DIAGRAM.source
/** Its shapes' and lines' labels, in the order the app draws them. */
const SIGN_IN_LABELS = ["Sign-in page", "Auth server", "Projects", "password", "session"]
/** Its source since the canvas was saved: it gained a box and a line. */
const CHANGED_D2 = `${SIGN_IN_D2}audit: Audit log\nauth -> audit: record\n`
const NOT_DRAWN = "Open it in elaborat.ing to draw it."

/** show_file's result for the diagram on its own, with what the card draws it from. */
function diagramShown(status: "not_drawn" | "stale", d2: Record<string, string>, svgs: Record<string, string> = {}) {
  return {
    content: [{ type: "text", text: `Showing ${SIGN_IN} (version 2) to the user.` }],
    structuredContent: {
      project_id: PROJECT,
      path: SIGN_IN,
      kind: "diagram",
      version: 2,
      updated_at: null,
      url: SIGN_IN_URL,
      truncated: false,
      embeds: [{ kind: "diagram", path: SIGN_IN, url: SIGN_IN_URL, status }],
    },
    _meta: { ...(Object.keys(svgs).length > 0 ? { "elaborat.ing/svg": svgs } : {}), "elaborat.ing/d2": { [SIGN_IN]: d2 } },
  }
}

/** show_file's result for a note that embeds diagrams the app has not drawn yet, each with its source. */
function noteShown(sources: Record<string, string>) {
  const paths = Object.keys(sources)
  const url = `https://elaborat.ing/projects/${PROJECT}/notes/sign-in.mdx`
  return {
    content: [{ type: "text", text: "Showing notes/sign-in.mdx (version 1) to the user." }],
    structuredContent: {
      project_id: PROJECT,
      path: "notes/sign-in.mdx",
      kind: "note",
      version: 1,
      updated_at: null,
      url,
      truncated: false,
      embeds: paths.map((path) => ({ kind: "diagram", path, url: `https://elaborat.ing/projects/${PROJECT}/${path}`, status: "not_drawn" })),
    },
    _meta: {
      "elaborat.ing/html": `<h1>Sign-in flow</h1><p>How someone signs in.</p>${paths.map((_, index) => `<figure class="embed" data-embed="${index}"></figure>`).join("")}`,
      "elaborat.ing/source": `# Sign-in flow\n\nHow someone signs in.\n\n${paths.map((path) => `<Diagram src="${path}" />\n`).join("\n")}`,
      "elaborat.ing/d2": Object.fromEntries(paths.map((path) => [path, { source: sources[path] }])),
    },
  }
}

/** The text in the card's drawing of the diagram at `path`. */
const drawnText = (card: FrameLocator, path = SIGN_IN) => card.getByRole("img", { name: `Diagram ${path}` }).locator("text")
/** The card's files asked for that draw diagrams: the module, D2's engine and its worker. */
const DIAGRAM_FILES = ["diagram", "d2-engine", "d2-worker"]

test("a note's new D2 diagram is drawn in the card from its source, and one that does not compile says to open it and tells the model its error", async ({ page }) => {
  test.setTimeout(60_000)
  const card = await openHost(page, { tools: true, theme: "light", policy: "eval", result: noteShown({ [SIGN_IN]: SIGN_IN_D2, "flows/broken.d2": "x -> {\n" }) })
  await expect(card.getByText("How someone signs in.")).toBeVisible()
  // Its labels are in the drawing, laid out as the app lays it out.
  await expect(drawnText(card)).toHaveText(SIGN_IN_LABELS, { timeout: 30_000 })
  await expect(card.getByRole("img", { name: "Diagram flows/broken.d2" })).toHaveCount(0)
  await expect(card.getByText(NOT_DRAWN)).toHaveCount(1)
  await expect(card.locator('[data-slot="chat-card"]')).not.toHaveAttribute("aria-busy", "true")
  // The model hears D2's error on its next turn, once, so it can fix the source.
  await expect.poll(() => contexts(page)).toEqual([
    "The elaborat.ing card could not draw the diagram flows/broken.d2: its D2 source has an error. Fix the source with update_and_show. D2 said: flows/broken.d2:1:1: connection missing destination; flows/broken.d2:1:6: maps must be terminated with }",
  ])
  // The drawing module, and D2's engine and worker, came from elaborat.ing, under the host's policy.
  expect(asked(page)).toEqual(expect.arrayContaining(DIAGRAM_FILES))
  expect(await violations(page)).toEqual([])
})

test("a new D2 diagram shown on its own is drawn in the card, on the dotted canvas in dark mode", async ({ page }) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 390, height: 800 })
  const card = await openHost(page, { tools: true, theme: "dark", policy: "eval", result: diagramShown("not_drawn", { source: SIGN_IN_D2 }) })
  await expect(drawnText(card)).toHaveText(SIGN_IN_LABELS, { timeout: 30_000 })
  // The palette's diagram fills, through the dark filter, as for a diagram the app drew.
  await expect(card.locator(".card-art svg .d2-fill").first()).toBeAttached()
  await expect(card.locator(".card-art svg")).toHaveCSS("filter", /invert/)
  await expect(card.getByText(NOT_DRAWN)).toHaveCount(0)
  expect(await page.frames()[1].evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  expect(await violations(page)).toEqual([])
})

test("a D2 diagram whose source changed is drawn from the new source, keeping the shape moved by hand", async ({ page }) => {
  test.setTimeout(60_000)
  // Since its canvas was saved, with Projects moved, the source gained a box and a line.
  const result = diagramShown("stale", { source: CHANGED_D2, canvas: SAVED_DIAGRAM.canvas, layout: SAVED_DIAGRAM.layout }, { [SIGN_IN]: SVG })
  const card = await openHost(page, { tools: true, theme: "light", policy: "eval", result })
  const drawing = card.getByRole("img", { name: `Diagram ${SIGN_IN}` })
  await expect(drawing.locator("text", { hasText: "Audit log" })).toHaveCount(1, { timeout: 30_000 })
  await expect(drawing.locator("text", { hasText: "record" })).toHaveCount(1)
  // Projects stays where it was moved to on the canvas.
  const moved = (JSON.parse(SAVED_DIAGRAM.canvas).elements as Array<{ id: string; x: number; y: number }>).find((element) => element.id === "d2:projects:label")!
  await expect(drawing.locator(`g[transform="translate(${moved.x} ${moved.y})"] text`)).toHaveText("Projects")
  // Drawn from its source as it is now, it is not out of date.
  await expect(card.getByText("Its source changed after this was drawn.", { exact: false })).toHaveCount(0)
  expect(await violations(page)).toEqual([])
})

/** What the model hears about a diagram the card could not draw because D2's engine does not run in the chat, and what the user `sees`. */
const engineNote = (path: string, sees: string) =>
  `The elaborat.ing card could not draw the diagram ${path}: this chat does not let it run D2's engine. The user sees ${sees}. If they want to see it in the chat, offer to make it as an Excalidraw drawing with create_and_show and a .excalidraw path.`

test("where D2's engine does not load, a new diagram says to open it and a changed one shows as last drawn, and the model hears what each shows", async ({ page }) => {
  const card = await openHost(page, { tools: true, theme: "light", policy: "eval", result: null, manual: true })
  const failed: string[] = []
  await page.route(`${APP}/chat-card/d2-engine-*`, (route) => {
    failed.push(route.request().url())
    return route.fulfill({ status: 404 })
  })
  await expect.poll(() => page.evaluate(() => (window as unknown as { ready?: boolean }).ready)).toBe(true)
  await send(page, "ui/notifications/tool-result", noteShown({ [SIGN_IN]: SIGN_IN_D2 }))
  await expect.poll(() => failed.length).toBe(1)
  await expect(card.getByText(NOT_DRAWN)).toBeVisible()
  await expect(card.getByRole("img", { name: `Diagram ${SIGN_IN}` })).toHaveCount(0)
  await expect(card.locator('[data-slot="chat-card"]')).not.toHaveAttribute("aria-busy", "true")

  await send(page, "ui/notifications/tool-result", diagramShown("stale", { source: CHANGED_D2, canvas: SAVED_DIAGRAM.canvas, layout: SAVED_DIAGRAM.layout }, { [SIGN_IN]: SVG }))
  await expect(card.getByRole("status").filter({ hasText: "Its source changed after this was drawn." })).toBeVisible()
  await expect(card.getByRole("img", { name: `Diagram ${SIGN_IN}` }).locator("rect")).toHaveCount(1)
  // The model hears what the user sees each time, and that it can offer a drawing.
  await expect.poll(() => contexts(page)).toEqual([engineNote(SIGN_IN, "only a link to open it in elaborat.ing"), engineNote(SIGN_IN, "it as it was drawn before its source changed")])
})

test("where the host's policy does not let D2's engine run, a new diagram says to open it, and the model hears it can offer a drawing instead", async ({ page }) => {
  // The view's declared policy: no WebAssembly, no code from strings, no blob: workers.
  const card = await openHost(page, { tools: true, theme: "light", result: noteShown({ [SIGN_IN]: SIGN_IN_D2, "flows/audit.d2": "audit: Audit log\n" }) })
  await expect(card.getByText(NOT_DRAWN)).toHaveCount(2)
  await expect(card.locator('[data-slot="chat-card"]')).not.toHaveAttribute("aria-busy", "true")
  // Once for each diagram, the latest with the one before it, since a host keeps only the latest.
  const sees = "only a link to open it in elaborat.ing"
  await expect.poll(() => contexts(page)).toEqual([engineNote(SIGN_IN, sees), `${engineNote(SIGN_IN, sees)}\n${engineNote("flows/audit.d2", sees)}`])
  // The host's policy refused the engine's worker.
  expect(await violations(page)).toEqual(["worker-src blob"])
})

test("the model hears all the card has told it in one context: a diagram the card could not draw, a save, then another diagram", async ({ page }) => {
  // The view's declared policy does not let D2's engine run.
  const card = await openHost(page, { tools: true, theme: "light", result: noteShown({ [SIGN_IN]: SIGN_IN_D2 }) })
  const sees = "only a link to open it in elaborat.ing"
  await expect.poll(() => contexts(page)).toEqual([engineNote(SIGN_IN, sees)])
  await card.getByRole("button", { name: "Edit" }).click()
  await card.locator(".ProseMirror").getByText("How someone signs in.").click()
  await page.keyboard.press("End")
  await page.keyboard.type(" Then the audit log.")
  // Saved, the note comes back with a second new diagram.
  const saved = noteShown({ [SIGN_IN]: SIGN_IN_D2, "flows/audit.d2": "audit: Audit log\n" })
  await answer(page, "write_file", { content: [{ type: "text", text: "{}" }], structuredContent: { status: "saved", changes: [{ op: "put", path: "notes/sign-in.mdx", version: 2 }] } })
  await answer(page, "show_file", { ...saved, structuredContent: { ...saved.structuredContent, version: 2 } })
  await card.getByRole("button", { name: "Save" }).click()
  await expect(card.getByText("Saved as v2.")).toBeVisible()
  // A host keeps only the latest context the card gives it: the save keeps the diagram before it, and the diagram after it keeps the save.
  const save = "The user edited notes/sign-in.mdx in the elaborat.ing card and saved it as version 2. Read it again before changing it."
  await expect.poll(() => contexts(page)).toEqual([
    engineNote(SIGN_IN, sees),
    `${engineNote(SIGN_IN, sees)}\n${save}`,
    `${engineNote(SIGN_IN, sees)}\n${save}\n${engineNote("flows/audit.d2", sees)}`,
  ])
})

test("D2's engine loads only for a card with a diagram to draw", async ({ page }) => {
  test.setTimeout(60_000)
  // A diagram the app has drawn, and a drawing: there is nothing for the card to draw.
  const note = shown(4, "# Plan\n")
  const drawn = {
    ...note,
    structuredContent: {
      ...note.structuredContent,
      embeds: [
        { kind: "diagram", path: SIGN_IN, url: SIGN_IN_URL, status: "drawn" },
        { kind: "drawing", path: "art/flow.excalidraw", url: `https://elaborat.ing/projects/${PROJECT}/art/flow.excalidraw`, status: "drawn" },
      ],
    },
    _meta: {
      ...note._meta,
      "elaborat.ing/html": '<h1>Plan</h1><figure class="embed" data-embed="0"></figure><figure class="embed" data-embed="1"></figure>',
      "elaborat.ing/svg": { [SIGN_IN]: SVG, "art/flow.excalidraw": SVG },
    },
  }
  let card = await openHost(page, { tools: true, theme: "light", policy: "eval", result: drawn })
  await expect(card.getByRole("img", { name: `Diagram ${SIGN_IN}` })).toBeVisible()
  await expect(card.getByRole("img", { name: "Drawing art/flow.excalidraw" })).toBeVisible()
  await page.waitForTimeout(500)
  expect(asked(page).filter((name) => DIAGRAM_FILES.includes(name))).toEqual([])

  // A note with a new diagram loads them.
  card = await openHost(page, { tools: true, theme: "light", policy: "eval", result: noteShown({ [SIGN_IN]: SIGN_IN_D2 }) })
  await expect(drawnText(card)).toHaveText(SIGN_IN_LABELS, { timeout: 30_000 })
  expect(asked(page)).toEqual(expect.arrayContaining(DIAGRAM_FILES))
})

/** The workers running D2's engine on the page: each card starts its own, from a blob: URL. */
const engines = (page: Page) => page.workers().filter((worker) => worker.url().startsWith("blob:")).length

test("a card stops D2's engine once it has had nothing to lay out for 10 s, and starts it again for a later diagram", async ({ page }) => {
  test.setTimeout(90_000)
  await page.clock.install()
  const result = noteShown({ [SIGN_IN]: SIGN_IN_D2 })
  const card = await openHost(page, { tools: true, theme: "light", policy: "eval", result })
  await expect(drawnText(card)).toHaveText(SIGN_IN_LABELS, { timeout: 30_000 })
  expect(engines(page)).toBe(1)
  // Its worker holds the engine's memory, a lot for a phone: it stops 10 s after the last layout.
  await page.clock.fastForward(10_000)
  await expect.poll(() => engines(page)).toBe(0)

  // The same result shown again keeps its drawing, with no engine.
  await send(page, "ui/notifications/tool-result", result)
  await expect(drawnText(card)).toHaveText(SIGN_IN_LABELS)
  await page.waitForTimeout(500)
  expect(engines(page)).toBe(0)

  // Edited and saved, the note comes back with its diagram changed since: the engine starts again and draws it.
  await card.getByRole("button", { name: "Edit" }).click()
  await card.locator(".ProseMirror").getByText("How someone signs in.").click()
  await page.keyboard.press("End")
  await page.keyboard.type(" Then the projects show.")
  const changed = noteShown({ [SIGN_IN]: CHANGED_D2 })
  await answer(page, "write_file", { content: [{ type: "text", text: "{}" }], structuredContent: { status: "saved", changes: [{ op: "put", path: "notes/sign-in.mdx", version: 2 }] } })
  await answer(page, "show_file", { ...changed, structuredContent: { ...changed.structuredContent, version: 2 } })
  await card.getByRole("button", { name: "Save" }).click()
  await expect(card.getByText("Saved as v2.")).toBeVisible()
  await expect(drawnText(card).filter({ hasText: "Audit log" })).toHaveCount(1, { timeout: 30_000 })
  expect(engines(page)).toBe(1)
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

test("an isolated MDX chat-card preview copies exact code only after a person gesture", async ({ page }) => {
  const result = copyNote()
  const card = await openHost(page, {
    tools: false,
    theme: "light",
    result: { ...result, _meta: { ...result._meta, "elaborat.ing/components": { modules: {} } } },
  })
  const note = preview(page, PATH)
  await expect(note.locator(".document-code")).toHaveCount(COPY_SAMPLES.length)
  await expect(note.locator(".document-code-highlight")).toHaveCount(0)
  await cardClipboard(page)

  // A component can invent messages, so the trusted card also checks its
  // own browser activation. Rendering alone cannot replace the clipboard.
  const unasked = await previewFrame(page).evaluate(() => new Promise<boolean>((resolve, reject) => {
    const run = Number(/run:(\d+)/.exec(document.scripts[0].textContent ?? "")![1])
    let timer = 0
    const received = (event: MessageEvent) => {
      if (event.source !== parent || event.data?.type !== "copy-result" || event.data.request !== 999) return
      window.clearTimeout(timer)
      window.removeEventListener("message", received)
      resolve(event.data.ok)
    }
    window.addEventListener("message", received)
    // Playwright's evaluate itself grants transient activation. Let that
    // expire inside this task's callback before simulating an unasked message.
    const deadline = performance.now() + 10_000
    const unactivated = (): void => {
      if (navigator.userActivation.isActive) {
        if (performance.now() > deadline) {
          window.removeEventListener("message", received)
          return reject(new Error("Browser activation did not expire"))
        }
        window.setTimeout(unactivated, 50)
        return
      }
      timer = window.setTimeout(() => {
        window.removeEventListener("message", received)
        reject(new Error("Copy result not received"))
      }, 5_000)
      parent.postMessage({ type: "copy-code", run, request: 999, text: "unasked clipboard change" }, "*")
    }
    unactivated()
  }))
  expect(unasked).toBe(false)
  expect(await cardCopied(page)).toEqual([])

  for (let index = 0; index < COPY_SAMPLES.length; index++) {
    const block = note.locator(".document-code").nth(index)
    await block.getByRole("button", { name: "Copy code", exact: true }).focus()
    await page.keyboard.press("Enter")
    await expect(block.getByRole("status")).toHaveText("Copied")
    await expect.poll(() => cardCopied(page)).toEqual(COPY_SAMPLES.slice(0, index + 1).map(([, code]) => code))
  }
  await cardFrame(page).evaluate(() => { (window as unknown as { refuseCopy: boolean }).refuseCopy = true })
  const block = note.locator(".document-code").first()
  await block.getByRole("button", { name: "Copy code", exact: true }).click()
  await expect(block.getByRole("status")).toContainText("Could not copy")
  await expect(block.getByRole("button", { name: "Copy code", exact: true })).toBeEnabled()
  await cardFrame(page).evaluate(() => { (window as unknown as { refuseCopy: boolean }).refuseCopy = false })
  await block.getByRole("button", { name: "Copy code", exact: true }).click()
  await expect(block.getByRole("status")).toHaveText("Copied")
  await expect(card.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0)
  expect(await calls(page)).toEqual([])
  expect(await violations(page)).toEqual([])
})

for (const theme of ["light", "dark"] as const) {
  test(`a note's built-in and workspace components show in a sandboxed frame, and one that throws shows its error (${theme})`, async ({ page, appErrors }) => {
    appErrors.expect("Broken could not be shown: Broken on purpose")
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

  test(`a draft component file shows each component with its sample props, and the model hears about the one that throws (${theme})`, async ({ page, appErrors }) => {
    appErrors.expect("Broken could not be shown: Broken on purpose")
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

test("a component file whose code does not compile is a problem in the card, and the model hears why", async ({ page, appErrors }) => {
  appErrors.expect("This component could not be shown: An import or export is not valid JavaScript")
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

/** A drawing in draw's short form: shapes with a label and no size, arrows by from and to, one to a shape that never comes. */
const SHORT_FLOW_SCENE = JSON.stringify(
  {
    type: "excalidraw",
    version: 2,
    elements: [
      { id: "a", type: "rectangle", x: 0, y: 0, label: 'Write "it"' },
      { id: "b", type: "ellipse", x: 300, y: 0, label: "Ship } it" },
      { id: "ab", type: "arrow", from: "a", to: "b", label: "then" },
      { id: "bc", type: "arrow", from: "b", to: "c" },
    ],
    appState: { viewBackgroundColor: "#ffffff" },
  },
  null,
  2,
)

test("a new drawing in draw's short form draws in as the server saves it: each shape sized to its label, and an arrow once both its shapes have come", async ({ page }) => {
  const card = await openHost(page, { tools: true, theme: "light", result: null, manual: true })
  const counts: number[] = []
  await writeIn(page, FLOW, SHORT_FLOW_SCENE, cutsOf(SHORT_FLOW_SCENE, 7), async () => {
    counts.push(await liveShapes(page))
  })
  expect(counts).toEqual([...counts].sort((a, b) => a - b))
  // Each shape and its label, then the arrow between them and its label; not the arrow to "c", which never came.
  await expect.poll(() => liveShapes(page)).toBe(6)
  await expect(card.locator(".live-svg text")).toHaveText(['Write "it"', "Ship } it", "then"])
  // Where the server puts them: the box 145 by 70 for its label, the ellipse 184 by 70, the labels centred, the arrow 8 px off each.
  expect(await placed(page)).toEqual(["translate(0 0)", "translate(20 22.5)", "translate(300 0)", "translate(347.25 22.5)", "translate(153 35)", "translate(199.5 22.5)"])
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

test("a live note's copy button follows its current code without copying the writing caret", async ({ page }) => {
  const card = await openHost(page, { tools: false, theme: "light", result: null, manual: true })
  await expect.poll(() => page.evaluate(() => (window as unknown as { ready?: boolean }).ready)).toBe(true)
  await cardClipboard(page)
  const source = (code: string) => `# Live code\n\n\`\`\`cpp\n${code}\n\`\`\``
  const code = COPY_SAMPLES[0][1]
  await send(page, "ui/notifications/tool-input-partial", input("notes/live-code.md", source(code)))
  const block = card.locator("[data-live-content] .document-code")
  await expect(block.locator("code .live-caret")).toHaveCount(1)
  await block.getByRole("button", { name: "Copy code", exact: true }).click()
  await expect(block.getByRole("status")).toHaveText("Copied")
  await expect.poll(() => cardCopied(page)).toEqual([code])

  const next = code.replace("return 0", "return 1")
  await send(page, "ui/notifications/tool-input-partial", input("notes/live-code.md", source(next)))
  await expect(block.locator("pre")).toContainText("return 1")
  await block.getByRole("button", { name: "Copy code", exact: true }).click()
  await expect(block.getByRole("status")).toHaveText("Copied")
  await expect.poll(() => cardCopied(page)).toEqual([code, next])
  expect(await calls(page)).toEqual([])
  expect(await violations(page)).toEqual([])
})

test("a new D2 diagram writes in as source while its engine starts, and its drawing takes the source's place when the result comes", async ({ page }) => {
  test.setTimeout(60_000)
  const card = await openHost(page, { tools: true, theme: "light", policy: "eval", result: null, manual: true })
  await expect.poll(() => page.evaluate(() => (window as unknown as { ready?: boolean }).ready)).toBe(true)
  // Notes whether the card ever says it could not draw the diagram, and each thing its footer says.
  await cardFrame(page).evaluate((note) => {
    const state = window as unknown as { saidNotDrawn: boolean; footer: string[] }
    state.saidNotDrawn = false
    state.footer = []
    const root = document.getElementById("root")!
    new MutationObserver(() => {
      if (root.textContent?.includes(note)) state.saidNotDrawn = true
      const said = root.querySelector('footer [role="status"]')?.textContent
      if (said && said !== state.footer.at(-1)) state.footer.push(said)
    }).observe(root, { subtree: true, childList: true, characterData: true })
  }, NOT_DRAWN)
  await writeIn(page, SIGN_IN, SIGN_IN_D2, cutsOf(SIGN_IN_D2, 4))
  await expect(card.locator(".live-source")).toContainText("auth -> projects: session")
  // D2's engine starts loading while the source comes in.
  await expect.poll(() => asked(page)).toEqual(expect.arrayContaining(DIAGRAM_FILES))

  await send(page, "ui/notifications/tool-input", input(SIGN_IN, SIGN_IN_D2))
  const result = diagramShown("not_drawn", { source: SIGN_IN_D2 })
  await send(page, "ui/notifications/tool-result", { ...result, content: [{ type: "text", text: `Created ${SIGN_IN} (version 1) and showed it to the user.` }] })
  await expect(drawnText(card)).toHaveText(SIGN_IN_LABELS, { timeout: 30_000 })
  await expect(card.locator(".live-source")).toHaveCount(0)
  await expect(card.getByRole("link", { name: "Open in elaborat.ing" })).toHaveAttribute("href", SIGN_IN_URL)
  expect(await cardFrame(page).evaluate(() => (window as unknown as { saidNotDrawn: boolean }).saidNotDrawn)).toBe(false)
  // Once its source is in, the footer says the diagram is being laid out while the card waits for its drawing.
  expect(await cardFrame(page).evaluate(() => (window as unknown as { footer: string[] }).footer)).toEqual([`Writing ${SIGN_IN}`, `Laying out ${SIGN_IN}`])
  expect(await violations(page)).toEqual([])
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

test("in ChatGPT, a result whose _meta comes late in the globals keeps its drawing once the live view has settled", async ({ page }) => {
  const card = await openHost(page, { tools: true, theme: "light", result: null, manual: true, chatgpt: true })
  await expect.poll(() => page.evaluate(() => (window as unknown as { ready?: boolean }).ready)).toBe(true)
  // The result comes without _meta, and the globals bring it just after, while the drawing is still drawing in.
  await cardFrame(page).evaluate((meta) => {
    window.addEventListener("message", (event) => {
      if ((event.data as { method?: string } | null)?.method !== "ui/notifications/tool-result") return
      ;(window as unknown as { openai: Record<string, unknown> }).openai.toolResponseMetadata = meta
      window.dispatchEvent(new Event("openai:set_globals"))
    })
  }, FLOW_RESULT._meta)
  await send(page, "ui/notifications/tool-input-partial", input(FLOW, FLOW_SCENE))
  await expect.poll(() => liveShapes(page), { intervals: [20] }).toBeGreaterThan(0)
  await send(page, "ui/notifications/tool-input", input(FLOW, FLOW_SCENE))
  await send(page, "ui/notifications/tool-result", { content: FLOW_RESULT.content, structuredContent: FLOW_RESULT.structuredContent })
  const drawing = card.getByRole("img", { name: `Drawing ${FLOW}` })
  await expect(drawing).toBeVisible()
  // Past the live view's settle (at most 600 ms), the drawing is still there.
  await page.waitForTimeout(1000)
  expect(await drawing.isVisible()).toBe(true)
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

test("a drawing that could not be saved leaves nothing of it on screen, only why", async ({ page, appErrors }) => {
  const card = await openHost(page, { tools: true, theme: "light", result: null, manual: true })
  await writeIn(page, FLOW, FLOW_SCENE, cutsOf(FLOW_SCENE, 4))
  await expect.poll(() => liveShapes(page)).toBeGreaterThan(0)
  const message = `A file already exists at ${FLOW}. Nothing was saved. To change it, read it and use write_file with base_version.`
  appErrors.expect(message)
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
  // And in silence: there is no pencil sound to mute.
  await expect(card.getByRole("button", { name: "Pencil sound" })).toHaveCount(0)
  await send(page, "ui/notifications/tool-input", input(FLOW, FLOW_SCENE))
  await send(page, "ui/notifications/tool-result", FLOW_RESULT)
  await expect(card.getByRole("img", { name: `Drawing ${FLOW}` })).toBeVisible()
})

// update_and_show: a change to a saved file shown as the agent writes it. When
// the first partial input names the file, the card reads it as saved through
// the host (read_file): what the change keeps shows at once, and what it
// changes or adds comes in. Once the card settles it reports how the host
// sent the input (card_report).

/** The drawing as saved: two shapes the change keeps and one it leaves out. */
const SAVED_SCENE = JSON.stringify(
  {
    type: "excalidraw",
    version: 2,
    elements: [
      ...JSON.parse(FLOW_SCENE).elements.slice(0, 2),
      { ...shape, id: "gone", type: "rectangle", x: 500, y: 200, width: 80, height: 40, seed: 9 },
    ],
    appState: { viewBackgroundColor: "#ffffff" },
  },
  null,
  2,
)
/** The change: the two kept as they were (their bookkeeping moved on), and a new ellipse. */
const CHANGED_SCENE = JSON.stringify(
  {
    type: "excalidraw",
    version: 2,
    elements: [...JSON.parse(FLOW_SCENE).elements.slice(0, 2).map((element: Record<string, unknown>) => ({ ...element, version: 5 })), JSON.parse(FLOW_SCENE).elements[2]],
    appState: { viewBackgroundColor: "#ffffff" },
  },
  null,
  2,
)
/** Where each element is placed in the live view, by id. */
const PLACED = { a: "translate(0 0)", "a-label": "translate(30 22)", gone: "translate(500 200)", b: "translate(280 -10)" }

const updateInput = (path: string, content: string) => ({ arguments: { project_id: PROJECT, path, base_version: 3, content } })
const readAnswer = (path: string, content: string) => ({
  content: [{ type: "text", text: JSON.stringify({ path, content, version: 3 }) }],
  structuredContent: { path, content, version: 3, updated_at: null },
})
/** update_and_show's result: show_file's, for the saved change. */
const updated = (path: string, kind: "note" | "drawing", meta: Record<string, unknown>) => {
  const result = created(path, kind, meta)
  return { ...result, content: [{ type: "text", text: `Saved ${path} as version 4 and showed it to the user.` }], structuredContent: { ...result.structuredContent, version: 4 } }
}

/** The live view's elements on screen, by where they are placed. */
const placed = (page: Page) => cardFrame(page).evaluate(() => [...document.querySelectorAll(".live-svg > g")].map((g) => g.getAttribute("transform")))
/** Notes, in the card, the place of every element that animates from now on. */
const watchAnimations = (page: Page) =>
  cardFrame(page).evaluate(() => {
    const animated: string[] = []
    ;(window as unknown as { animated: string[] }).animated = animated
    const animate = Element.prototype.animate
    Element.prototype.animate = function (this: Element, ...args: Parameters<Element["animate"]>) {
      const g = this.closest(".live-svg > g")
      if (g) animated.push(g.getAttribute("transform") ?? "")
      return animate.apply(this, args)
    }
  })
const animated = (page: Page) => cardFrame(page).evaluate(() => [...new Set((window as unknown as { animated: string[] }).animated)])

test("a change to a drawing shows what it keeps at once, draws the new shape in, and the shape it drops fades", async ({ page }) => {
  const card = await openHost(page, { tools: true, theme: "light", result: null, manual: true })
  await answer(page, "read_file", readAnswer(FLOW, SAVED_SCENE))
  await expect.poll(() => page.evaluate(() => (window as unknown as { ready?: boolean }).ready)).toBe(true)
  await watchAnimations(page)

  // The first partial input names the file; none of its elements is written yet.
  const opening = CHANGED_SCENE.indexOf('"elements"') + 12
  await send(page, "ui/notifications/tool-input-partial", updateInput(FLOW, CHANGED_SCENE.slice(0, opening)))
  // The saved drawing shows at once, as it is.
  await expect.poll(() => placed(page)).toEqual([PLACED.a, PLACED["a-label"], PLACED.gone])
  await expect(card.getByRole("status").filter({ hasText: `Drawing ${FLOW}` })).toBeVisible()
  expect((await calls(page)).filter((call) => call.name === "read_file")).toEqual([{ name: "read_file", arguments: { project_id: PROJECT, path: FLOW } }])

  // The rest comes in: the kept shapes stay as they are, and the new one draws in.
  const cuts = cutsOf(CHANGED_SCENE, 6).filter((cut) => cut > opening)
  for (const cut of [...cuts, CHANGED_SCENE.length]) {
    await send(page, "ui/notifications/tool-input-partial", updateInput(FLOW, CHANGED_SCENE.slice(0, cut)))
    await page.waitForTimeout(80)
  }
  await expect.poll(() => placed(page)).toEqual([PLACED.a, PLACED["a-label"], PLACED.gone, PLACED.b])
  expect(await animated(page)).toEqual([PLACED.b])

  // Once the whole input is in, the shape the change leaves out fades away.
  await send(page, "ui/notifications/tool-input", updateInput(FLOW, CHANGED_SCENE))
  await expect.poll(() => placed(page)).toEqual([PLACED.a, PLACED["a-label"], PLACED.b])
  expect(await animated(page)).toEqual([PLACED.b, PLACED.gone])

  await send(page, "ui/notifications/tool-result", updated(FLOW, "drawing", { "elaborat.ing/svg": { [FLOW]: SVG } }))
  await expect(card.getByRole("img", { name: `Drawing ${FLOW}` })).toBeVisible()
  await expect(card.getByText("v4", { exact: true })).toBeVisible()
  await expect(card.locator(".live-svg")).toHaveCount(0)

  // It tells the server once how the host sent the input.
  await expect.poll(async () => (await calls(page)).filter((call) => call.name === "card_report").length).toBe(1)
  const [report] = (await calls(page)).filter((call) => call.name === "card_report")
  expect(report.arguments).toEqual({ host: "stand-in", tool: "update_and_show", partials: cuts.length + 2, first_partial_ms: expect.any(Number), total_ms: expect.any(Number) })
  expect(Number(report.arguments.total_ms)).toBeGreaterThan(Number(report.arguments.first_partial_ms))
  await page.waitForTimeout(300)
  expect((await calls(page)).filter((call) => call.name === "card_report")).toHaveLength(1)
  expect(await violations(page)).toEqual([])
})

const SAVED_PLAN = ["# Launch plan", "", "Ship it *soon*, with care.", "", "- first item", "- second item", ""].join("\n")
const CHANGED_PLAN = `${SAVED_PLAN}\n## Next\n\nTell the team.\n`

test("a change to a note shows its unchanged opening at once and writes the new part in", async ({ page }) => {
  const card = await openHost(page, { tools: true, theme: "dark", result: null, manual: true })
  await answer(page, "read_file", readAnswer("notes/launch.mdx", SAVED_PLAN))
  await expect.poll(() => page.evaluate(() => (window as unknown as { ready?: boolean }).ready)).toBe(true)
  await send(page, "ui/notifications/tool-input-partial", updateInput("notes/launch.mdx", "# Lau"))
  // Only the start of the heading is written, and the note shows as saved, at once and with no caret.
  const live = card.locator("[data-live-content]")
  await expect(live.getByText("second item")).toBeVisible()
  await expect(live.locator("h1")).toHaveText("Launch plan")
  await expect(live.locator(".live-caret")).toHaveCount(0)
  await expect(live.getByText("Tell the team.")).toHaveCount(0)

  // The new part is written in after it as it comes, under a caret.
  const heading = CHANGED_PLAN.indexOf("Tell")
  for (const cut of [SAVED_PLAN.length + 4, heading]) {
    await send(page, "ui/notifications/tool-input-partial", updateInput("notes/launch.mdx", CHANGED_PLAN.slice(0, cut)))
    await page.waitForTimeout(120)
  }
  await expect(live.locator("h2")).toHaveText("Next")
  await expect(live.locator(".live-caret")).toHaveCount(1)
  await expect(live.getByText("Tell the team.")).toHaveCount(0)
  await send(page, "ui/notifications/tool-input-partial", updateInput("notes/launch.mdx", CHANGED_PLAN))
  await expect(live.getByText("Tell the team.")).toBeVisible()
  // What was saved stayed as it was: none of it came in again.
  await expect(live.getByText("second item")).toBeVisible()
  await expect(live.locator(".live-in").filter({ hasText: /Launch plan|soon|first item/ })).toHaveCount(0)

  await send(page, "ui/notifications/tool-input", updateInput("notes/launch.mdx", CHANGED_PLAN))
  await send(page, "ui/notifications/tool-result", updated("notes/launch.mdx", "note", { "elaborat.ing/html": "<h1>Launch plan</h1><p>As saved, with the next step.</p>", "elaborat.ing/source": CHANGED_PLAN }))
  await expect(card.getByText("As saved, with the next step.")).toBeVisible()
  await expect(live).toHaveCount(0)
})

test("a change saved over by someone else first shows the server's message, and nothing of the change", async ({ page, appErrors }) => {
  const card = await openHost(page, { tools: true, theme: "light", result: null, manual: true })
  await answer(page, "read_file", readAnswer(FLOW, SAVED_SCENE))
  await expect.poll(() => page.evaluate(() => (window as unknown as { ready?: boolean }).ready)).toBe(true)
  await send(page, "ui/notifications/tool-input-partial", updateInput(FLOW, CHANGED_SCENE))
  await expect.poll(() => placed(page)).toContain(PLACED.b)
  const message = `Someone changed ${FLOW} first: it is now version 5. Nothing was saved. Read it again, merge, and retry.`
  appErrors.expect(message)
  const conflict = { status: "conflict", conflicts: [{ path: FLOW, base_version: 3, current: { version: 5, content: SAVED_SCENE } }] }
  await send(page, "ui/notifications/tool-input", updateInput(FLOW, CHANGED_SCENE))
  await send(page, "ui/notifications/tool-result", { content: [{ type: "text", text: message }, { type: "text", text: JSON.stringify(conflict) }], structuredContent: conflict })
  await expect(card.getByText(message)).toBeVisible()
  await expect(card.getByText("This file could not be shown")).toBeVisible()
  await expect(card.locator(".live-svg")).toHaveCount(0)
})

test("a drawing drawing in makes a pencil stroke for its shapes where the browser lets audio play, and the person can mute it", async ({ page }) => {
  const card = await openHost(page, { tools: true, theme: "light", result: null, manual: true })
  await expect.poll(() => page.evaluate(() => (window as unknown as { ready?: boolean }).ready)).toBe(true)
  // Counts the strokes the card starts, and finds out whether this browser lets the frame play audio unasked.
  const audible = await cardFrame(page).evaluate(async () => {
    const state = window as unknown as { strokes: number }
    state.strokes = 0
    const start = AudioBufferSourceNode.prototype.start
    AudioBufferSourceNode.prototype.start = function (this: AudioBufferSourceNode, ...args: Parameters<AudioBufferSourceNode["start"]>) {
      state.strokes++
      return start.apply(this, args)
    }
    const probe = new AudioContext()
    await Promise.race([probe.resume(), new Promise((resolve) => setTimeout(resolve, 300))])
    const running = probe.state === "running"
    await probe.close()
    return running
  })
  const strokes = () => cardFrame(page).evaluate(() => (window as unknown as { strokes: number }).strokes)

  await send(page, "ui/notifications/tool-input-partial", input(FLOW, FLOW_SCENE.slice(0, FLOW_SCENE.indexOf('"id": "c"'))))
  await expect.poll(() => liveShapes(page)).toBe(4)
  const sound = card.getByRole("button", { name: "Pencil sound" })
  await expect(sound).toHaveAttribute("aria-pressed", "true")
  // On by default; where the browser holds audio back, silent.
  if (audible) await expect.poll(strokes).toBeGreaterThan(0)
  else {
    await page.waitForTimeout(1500)
    expect(await strokes()).toBe(0)
  }

  // Muted, the rest draws in without a sound.
  await sound.click()
  await expect(sound).toHaveAttribute("aria-pressed", "false")
  const muted = await strokes()
  await send(page, "ui/notifications/tool-input-partial", input(FLOW, FLOW_SCENE))
  await expect.poll(() => liveShapes(page)).toBe(7)
  await page.waitForTimeout(1500)
  expect(await strokes()).toBe(muted)
})

const IMAGE_PIXELS = {dataURL:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKxkAAAAASUVORK5CYII=',width:1,height:1};
function imageResult(deferred = false, revision?:number) {
  return {
    structuredContent:{project_id:PROJECT,path:PATH,kind:'note',version:1,url:URL,truncated:false,embeds:[],images:[{key:'../assets/a.png',path:'assets/a.png',status:deferred ? 'deferred' : 'ready',...(revision === undefined ? {} : {revision})}]},
    _meta:{'elaborat.ing/html':'<h1>Image note</h1><p><span data-project-image="../assets/a.png">A project photo</span></p>','elaborat.ing/source':'# Image note\n\n![A project photo](../assets/a.png)','elaborat.ing/images':deferred ? {} : {'../assets/a.png':IMAGE_PIXELS}},
  };
}

test('project images display in card HTML and remain visible while editing the note',async ({page}) => {
  const card = await openHost(page,{tools:true,theme:'dark',result:imageResult()});
  await expect(card.getByRole('img',{name:'A project photo'})).toBeVisible();
  await expect(card.getByRole('img',{name:'A project photo'})).toHaveAttribute('src',IMAGE_PIXELS.dataURL);
  await card.getByRole('button',{name:'Edit',exact:true}).click();
  await expect(card.locator('.ProseMirror').getByRole('img',{name:'A project photo'})).toBeVisible();
  expect(await violations(page)).toEqual([]);
});

test('a captioned project image retains its pixels and caption formatting in card Edit',async ({page}) => {
  const result = imageResult();
  result._meta['elaborat.ing/html'] = '<figure><span data-project-image="../assets/a.png">A project photo</span><figcaption>A <strong>rich</strong> caption with a <a href="https://example.com">link</a>.</figcaption></figure>';
  result._meta['elaborat.ing/source'] = '<figure>\n\n![A project photo](../assets/a.png)\n\n<figcaption>\n\nA **rich** caption with a [link](https://example.com).\n\n</figcaption>\n</figure>';
  const card = await openHost(page,{tools:true,theme:'light',result});
  await expect(card.locator('figure').getByRole('img',{name:'A project photo'})).toBeVisible();
  await card.getByRole('button',{name:'Edit',exact:true}).click();
  const figure = card.locator('.ProseMirror figure');
  await expect(figure.getByRole('img',{name:'A project photo'})).toBeVisible();
  await expect(figure.locator('figcaption strong')).toHaveText('rich');
  await expect(figure.getByRole('link',{name:'link',exact:true})).toHaveAttribute('href','https://example.com');
});

test('deferred card images load through the image tool when a host drops call meta',async ({page}) => {
  const card = await openHost(page,{tools:true,theme:'light',result:null,manual:true,dropsCallMeta:true});
  await expect.poll(() => page.evaluate(() => Boolean((window as unknown as {ready?:boolean}).ready))).toBe(true);
  await answer(page,'get_image_preview',{structuredContent:{path:'assets/a.png',status:'ready',imagePreviews:{'assets/a.png':IMAGE_PIXELS}},_meta:{'elaborat.ing/images':{'assets/a.png':IMAGE_PIXELS}}});
  await page.evaluate(result => (window as unknown as {send:(method:string,params:unknown)=>void}).send('ui/notifications/tool-result',result),imageResult(true,7));
  await expect(card.getByRole('img',{name:'A project photo'})).toHaveAttribute('src',IMAGE_PIXELS.dataURL);
  expect(await calls(page)).toEqual([{name:'get_image_preview',arguments:{project_id:PROJECT,path:'assets/a.png',revision:7}}]);
});

test('a card without image tool calls retains the image description and app link',async ({page}) => {
  const card = await openHost(page,{tools:false,theme:'light',result:imageResult(true)});
  await expect(card.getByRole('img',{name:'A project photo'})).toHaveText('A project photo');
  await expect(card.getByRole('link',{name:/Open in elaborat.ing/})).toBeVisible();
  expect(await calls(page)).toEqual([]);
});
