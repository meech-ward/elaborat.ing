import { expect, test } from "@playwright/test"
import { frameOf, load, openHarness } from "./rendered-support.ts"
import { SANDBOX_URL } from "./urls.ts"

// The note frame's page on a sandbox domain (docs/architecture.md, Component
// isolation): the harness loads it from a second origin, served through the
// sandbox domain's Worker (tests/browser/sandbox-server.ts). When that page
// cannot load, the note renders in the srcdoc frame instead.

// As in rendered.spec.ts: Playwright's service worker blocking throws inside
// the sandboxed frame, and the harness registers no worker.
test.use({ serviceWorkers: "allow" })

const FRAME = 'iframe[title="Isolated document preview"]'
const SANDBOX = new URL(SANDBOX_URL).origin

const chartNote = `# Orders

Fruit this week.

<ChartContainer config={{ apples: { label: "Apples", color: "rgb(200, 60, 40)" }, pears: { label: "Pears", color: "rgb(60, 160, 60)" } }} aria-label="Fruit orders">
  <PieChart>
    <Pie data={[{ fruit: "apples", orders: 40 }, { fruit: "pears", orders: 35 }]} dataKey="orders" nameKey="fruit" isAnimationActive={false}>
      <Cell fill="var(--color-apples)" />
      <Cell fill="var(--color-pears)" />
    </Pie>
  </PieChart>
</ChartContainer>

\`\`\`js
const total = 40 + 35
\`\`\`
`

test("a note renders in the sandbox domain's frame, which loads its own charts and highlighter", async ({ page }) => {
  const parts: string[] = []
  page.on("request", (request) => {
    if (/\/(charts|highlighter)(-[^/]+)?\.js$/.test(new URL(request.url()).pathname)) parts.push(request.url())
  })
  const errors = await openHarness(page, `?sandbox=${encodeURIComponent(SANDBOX)}`)
  await load(page, chartNote, "mdx", "Fruit this week.")

  // The frame is the sandbox origin's page, in this build's folder.
  const frame = page.locator(FRAME)
  expect(await frame.getAttribute("src")).toMatch(new RegExp(`^${SANDBOX}/frame/[0-9a-f]{16}/$`))
  expect(await frame.getAttribute("srcdoc")).toBeNull()
  expect(await frame.getAttribute("sandbox")).toBe("allow-scripts")

  const slices = frameOf(page).getByRole("group", { name: "Fruit orders" }).locator(".recharts-pie-sector path")
  await expect(slices).toHaveCount(2)
  await expect(frameOf(page).locator(".document-code-highlight .shiki")).toContainText("const total = 40 + 35")
  // Its modules came from beside its page; it never asked the app for them.
  expect(parts.sort()).toEqual([expect.stringMatching(new RegExp(`^${SANDBOX}/frame/[0-9a-f]{16}/charts\\.js$`)), expect.stringMatching(new RegExp(`^${SANDBOX}/frame/[0-9a-f]{16}/highlighter\\.js$`))])
  expect(await page.evaluate(() => window.frameMessages.some((message) => message.kind === "load-module"))).toBe(false)
  expect(errors).toEqual([])
})

test("when the sandbox domain's page cannot load, the note renders in the srcdoc frame", async ({ page }) => {
  // Nothing listens on this port: the frame's page fails to load, as offline.
  const errors = await openHarness(page, `?sandbox=${encodeURIComponent("http://127.0.0.1:4179")}`)
  await page.evaluate((text) => window.renderedHarness.load(text, "mdx"), chartNote)
  await expect(frameOf(page).locator("p").filter({ hasText: "Fruit this week." })).toBeVisible({ timeout: 20_000 })
  const frame = page.locator(FRAME)
  expect(await frame.getAttribute("src")).toBeNull()
  expect(await frame.getAttribute("srcdoc")).toContain("<!doctype html>")
  // Its charts come from the app, as a srcdoc frame's do.
  await expect(frameOf(page).getByRole("group", { name: "Fruit orders" }).locator(".recharts-pie-sector path")).toHaveCount(2)
  expect(errors).toEqual([])
})

// A page the frame navigates to that never finishes loading, so the frame
// never loads a second time: it records what it is sent, and says ready as
// the frame does.
const AWAY = `${SANDBOX}/away`
const awayPage = `<!doctype html><title>Away</title><script>
window.received = []
addEventListener("message", (event) => received.push(event.data && event.data.kind))
parent.postMessage({ kind: "ready", session: "pending" }, "*")
</script><img src="/never" alt="">`

for (const mode of ["sandbox domain", "srcdoc"] as const) {
  test(`a page the ${mode} frame navigates to is sent nothing and heard from never, even one that never finishes loading`, async ({ page }) => {
    await page.route(AWAY, (route) => route.fulfill({ contentType: "text/html", body: awayPage }))
    await page.route(`${SANDBOX}/never`, () => {})
    const errors = await openHarness(page, mode === "srcdoc" ? "" : `?sandbox=${encodeURIComponent(SANDBOX)}`)
    // The note's code leaves its frame when asked.
    const note = `# Away\n\nStill here.\n\n{(() => { addEventListener("leave", () => { location.href = ${JSON.stringify(AWAY)} }); return null })()}\n`
    const { session } = await load(page, note, "mdx", "Still here.")
    await frameOf(page).locator("body").evaluate(() => dispatchEvent(new Event("leave")))
    await expect.poll(() => page.frames().some((frame) => frame.url() === AWAY)).toBe(true)
    const away = page.frames().find((frame) => frame.url() === AWAY)!
    await expect.poll(() => away.evaluate(() => Array.isArray((window as unknown as { received?: unknown }).received))).toBe(true)

    // The person edits the note, and the app has new pixels and colours to send.
    await page.evaluate((text) => {
      window.renderedHarness.edit(`${text}\nMore.\n`)
      window.renderedHarness.setResources({ "flow.d2": '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="2"></svg>' })
      window.renderedHarness.appearance("supabase-green", "dark")
    }, note)
    // The page speaks as the frame would, with the note's session.
    const revision = await page.evaluate(() => window.renderedHarness.state().revision)
    await away.evaluate(([session, revision]) => parent.postMessage({ kind: "render-error", session, revision, message: "Forged" }, "*"), [session, revision] as const)
    await page.waitForTimeout(1_000)

    expect(await away.evaluate(() => (window as unknown as { received: unknown[] }).received)).toEqual([])
    expect((await page.evaluate(() => window.renderedHarness.state().error)) ?? "").not.toContain("Forged")
    expect(errors).toEqual([])
  })
}

test("a frame that navigates itself is replaced, and the preview stops when it keeps doing so", async ({ page }) => {
  const errors = await openHarness(page, `?sandbox=${encodeURIComponent(SANDBOX)}`)
  // The note's code reloads its frame every time it runs.
  await page.evaluate((text) => window.renderedHarness.load(text, "mdx"), "# Away\n\nStill here.\n\n{(() => { location.reload(); return null })()}\n")
  await expect(page.getByText("The preview stopped: this note's code keeps leaving it.")).toBeVisible()
  await expect(page.locator(FRAME)).toHaveCount(0)
  expect(await page.evaluate(() => window.renderedHarness.source())).toContain("Still here.")
  expect(errors).toEqual([])
})
