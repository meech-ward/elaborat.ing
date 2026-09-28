import { expect, test, type Page } from "@playwright/test"
import { FILE_VIEW_HTML } from "../../supabase/functions/mcp-server/tools/fileViewHtml.ts"

// The show_file view (the chat card) in a stand-in MCP Apps host: a page that
// frames the view the way Claude and ChatGPT do (sandboxed, under the spec's
// default Content Security Policy) and answers its bridge messages. The note
// is edited in the card and saved with write_file.

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

// The spec's default policy for a view that declares no `_meta.ui.csp`.
const CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' data:; connect-src 'none'; object-src 'none'"

type Host = { tools: boolean; theme: "light" | "dark"; result: unknown; styles?: unknown }

/** Opens the stand-in host with the view in it; answers come from window.answers. */
async function openHost(page: Page, host: Host) {
  const view = FILE_VIEW_HTML.replace(
    "<head>",
    `<head><meta http-equiv="Content-Security-Policy" content="${CSP}"><script>window.violations=[];document.addEventListener('securitypolicyviolation',(e)=>window.violations.push(e.violatedDirective+' '+e.blockedURI))</script>`,
  )
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
      state.calls = calls
      state.contexts = contexts
      state.sizes = sizes
      state.answers = {}
      const frame = document.querySelector("iframe")!
      const reply = (id: unknown, result: unknown) => frame.contentWindow!.postMessage({ jsonrpc: "2.0", id, result }, "*")
      const send = (method: string, params: unknown) => frame.contentWindow!.postMessage({ jsonrpc: "2.0", method, params }, "*")
      window.addEventListener("message", (event) => {
        if (event.source !== frame.contentWindow) return
        const message = event.data as { id?: unknown; method?: string; params?: { name: string; arguments: unknown } }
        if (message.method === "ui/initialize") {
          reply(message.id, {
            protocolVersion: "2026-01-26",
            hostInfo: { name: "stand-in", version: "1.0.0" },
            hostCapabilities: host.tools ? { serverTools: {}, openLinks: {} } : { openLinks: {} },
            hostContext: { theme: host.theme, styles: host.styles },
          })
        } else if (message.method === "ui/notifications/initialized") {
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
        } else if (message.id !== undefined) {
          reply(message.id, {})
        }
      })
      frame.srcdoc = view
    },
    { view, host },
  )
  return page.frameLocator("iframe")
}

const answer = (page: Page, name: string, result: unknown) =>
  page.evaluate(({ name, result }) => {
    const answers = (window as unknown as { answers: Record<string, unknown[]> }).answers
    ;(answers[name] ??= []).push(result)
  }, { name, result })

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
  await edit(page)

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
  // The app's fonts come from the card's own script, so the default policy allows them.
  const fonts = () => page.frames()[1].evaluate(() => [...document.fonts].map((font) => [font.family.replaceAll('"', ""), font.status]))
  await expect.poll(fonts).toEqual([
    ["Space Grotesk Variable", "loaded"],
    ["JetBrains Mono Variable", "loaded"],
    ["Excalifont", "loaded"],
  ])
  // Runs under the default policy: no eval, no requests.
  expect(await violations(page)).toEqual([])
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

test("where the host cannot call tools, the card stays read-only, in the host's fonts, and reports its size", async ({ page }) => {
  const card = await openHost(page, {
    tools: false,
    theme: "light",
    result: shown(4, SOURCE),
    styles: { variables: { "--font-sans": "Georgia, serif" } },
  })
  await expect(card.getByText("Version 4 as rendered by the server.")).toBeVisible()
  await expect(card.getByRole("link", { name: "Open in elaborat.ing" })).toBeVisible()
  await expect(card.getByRole("button", { name: "Edit" })).toBeHidden()
  await expect(card.getByText("Launch plan")).toHaveCSS("font-family", /Georgia/)
  // The palette's light panel, as the host asked.
  await expect(card.locator('[data-slot="chat-card"]')).toHaveCSS("background-color", "rgb(255, 255, 255)")
  const sizes = () => page.evaluate(() => (window as unknown as { sizes: { width: number; height: number }[] }).sizes)
  const width = await page.frames()[1].evaluate(() => window.innerWidth)
  await expect.poll(async () => (await sizes()).at(-1)?.width).toBe(width)
  expect((await sizes()).at(-1)!.height).toBeGreaterThan(200)
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
