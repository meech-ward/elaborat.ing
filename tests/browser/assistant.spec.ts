import { expect, test, type Page } from "@playwright/test"
import { FakeProjectServer } from "../../src/features/project-storage/fakeServer.ts"
import { fakeSupabase, person, signedIn } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

// The assistant on a ChatGPT plan (this build has VITE_CHATGPT_PLAN). The
// token keeper's /chatgpt/status is answered here, and /chatgpt/responses by
// a stand-in fetch that streams canned rounds, holding at WAIT until the test
// lets it go on, so the live view can be seen while a write streams.

test.describe.configure({ timeout: 60_000 })

const sse = (events: Array<Record<string, unknown>>) => events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("")
const NOTE = "# New plan\n\nFirst line."
const CALL = { type: "function_call", id: "fc_1", call_id: "call_1", name: "write_file", namespace: "elaborating" }
const ARGS = JSON.stringify({ path: "notes/plan.md", content: NOTE })

/** Round one writes notes/plan.md, holding after its first words; round two answers. */
const WRITE_ROUNDS = [
  [
    sse([
      { type: "response.output_item.added", output_index: 0, item: { ...CALL, arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: ARGS.slice(0, ARGS.indexOf("First")) },
    ]),
    "WAIT",
    sse([
      { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: ARGS.slice(ARGS.indexOf("First")) },
      { type: "response.output_item.done", output_index: 0, item: { ...CALL, arguments: ARGS } },
      { type: "response.completed", response: { output: [{ type: "reasoning", id: "rs_1", encrypted_content: "opaque" }, { ...CALL, arguments: ARGS }] } },
    ]),
  ],
  [
    sse([
      { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: "Rewrote the plan. Save it to keep it." },
      { type: "response.completed", response: { output: [{ type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "Rewrote the plan. Save it to keep it." }] }] } },
    ]),
  ],
]

async function setUp(page: Page, rounds: Array<string[] | "LIMIT">) {
  const server = new FakeProjectServer()
  const remote = server.remote(person.id)
  const id = crypto.randomUUID()
  await remote.createProject(id, "Plans")
  await remote.saveFiles(id, crypto.randomUUID(), [{ op: "put", path: "notes/plan.md", content: "# Plan\n\nOld text." }])
  const fake = await fakeSupabase(page, { server })
  await signedIn(page)
  await page.route("**/chatgpt/status", (route) =>
    route.fulfill({ json: { connected: true, plan: true, email: "person@example.com", models: [{ slug: "gpt-sample", name: "GPT Sample" }], problem: null } }),
  )
  await page.addInitScript((canned) => {
    const state = { round: 0, bodies: [] as unknown[], release: () => {} }
    Object.assign(window, { __assistant: state })
    const original = window.fetch.bind(window)
    window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (!url.endsWith("/chatgpt/responses")) return original(input, init)
      state.bodies.push(JSON.parse(String(init?.body)))
      const parts = canned[state.round++]
      if (parts === "LIMIT" || !parts) {
        return new Response(JSON.stringify({ error: "usage_limit", message: "You have reached your ChatGPT usage limit for this app." }), { status: 429, headers: { "content-type": "application/json" } })
      }
      const encoder = new TextEncoder()
      const body = new ReadableStream({
        async start(controller) {
          for (const part of parts) {
            if (part === "WAIT") await new Promise<void>((resolve) => (state.release = resolve))
            else controller.enqueue(encoder.encode(part))
          }
          controller.close()
        },
      })
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
    }) as typeof window.fetch
  }, rounds)
  const chunks: string[] = []
  page.on("request", (request) => chunks.push(new URL(request.url()).pathname))
  await page.goto(new URL(`projects/${id}/notes/plan.md`, APP_URL).href)
  await expect(page.getByRole("status").filter({ hasText: "Synced" })).toBeVisible({ timeout: 15_000 })
  return { id, fake, chunks }
}

const assistantChunk = (paths: string[]) => paths.some((path) => /\/assets\/AssistantView-[\w-]+\.js$/.test(path))
const liveChunk = (paths: string[]) => paths.some((path) => /\/assets\/mount-[\w-]+\.js$/.test(path))

test("the assistant writes a note live, and its version waits as unsaved changes until Save", async ({ page }) => {
  const { id, fake, chunks } = await setUp(page, WRITE_ROUNDS)
  // Nothing of the assistant loads before it opens.
  expect(assistantChunk(chunks)).toBe(false)
  expect(chunks.some((path) => path.startsWith("/chatgpt/"))).toBe(false)

  await page.getByRole("button", { name: "Assistant", exact: true }).click()
  await expect.poll(() => assistantChunk(chunks)).toBe(true)
  const welcome = page.getByRole("dialog", { name: "You're using your ChatGPT plan" })
  await expect(welcome).toBeVisible()
  await welcome.getByRole("button", { name: "Got it" }).click()
  await expect(welcome).toHaveCount(0)

  const panel = page.getByRole("complementary", { name: "Assistant" })
  await expect(panel.getByText("Using ChatGPT plan")).toBeVisible()
  await expect(panel.getByRole("link", { name: "Manage usage" })).toHaveAttribute("href", "https://chatgpt.com/settings/usage")
  expect(liveChunk(chunks)).toBe(false)
  await panel.getByRole("textbox", { name: "Message the assistant" }).fill("Rewrite the plan")
  await panel.getByRole("button", { name: "Send" }).click()

  // While the write streams, the live view covers the editor with the note so far.
  const live = page.getByRole("region", { name: "Assistant writing notes/plan.md" })
  await expect(live).toBeVisible()
  await expect(live.getByRole("heading", { name: "New plan" })).toBeVisible()
  expect(liveChunk(chunks)).toBe(true)
  await expect(page.getByRole("button", { name: "Assistant, working" })).toBeVisible()
  await expect(panel.getByRole("button", { name: "Stop" })).toBeVisible()
  await page.evaluate(() => (window as unknown as { __assistant: { release: () => void } }).__assistant.release())

  // Then the content lands in the tab as unsaved changes: nothing is saved until Save.
  await expect(live).toHaveCount(0)
  await expect(page.getByRole("tab", { name: "notes/plan.md, unsaved changes" })).toBeVisible()
  await expect(panel.getByText("Rewrote the plan. Save it to keep it.")).toBeVisible()
  await expect(panel.locator('[data-slot="assistant-step"]')).toHaveText(["Wrote notes/plan.md"])
  expect(fake.server.content(id, "notes/plan.md")).toBe("# Plan\n\nOld text.")
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect.poll(() => fake.server.content(id, "notes/plan.md")).toBe(NOTE)
  await expect(page.getByRole("tab", { name: "notes/plan.md, unsaved changes" })).toHaveCount(0)

  // The browser sent only the model and the chat, the second time with the call's output and the reasoning.
  const bodies = await page.evaluate(() => (window as unknown as { __assistant: { bodies: Array<{ model: string; input: Array<Record<string, unknown>> }> } }).__assistant.bodies)
  expect(Object.keys(bodies[0]).sort()).toEqual(["input", "model"])
  expect(bodies[0]).toEqual({ model: "gpt-sample", input: [{ role: "user", content: "Rewrite the plan" }] })
  expect(bodies[1].input.map((item) => item.type ?? item.role)).toEqual(["user", "reasoning", "function_call", "function_call_output"])
})

test("at the usage limit the panel says so, with Manage usage as its action", async ({ page }) => {
  await setUp(page, ["LIMIT"])
  await page.getByRole("button", { name: "Assistant", exact: true }).click()
  await page.getByRole("dialog", { name: "You're using your ChatGPT plan" }).getByRole("button", { name: "Got it" }).click()
  const panel = page.getByRole("complementary", { name: "Assistant" })
  await panel.getByRole("textbox", { name: "Message the assistant" }).fill("Draw the flow")
  await panel.getByRole("button", { name: "Send" }).click()
  await expect(panel.getByText("Usage limit reached")).toBeVisible()
  const manage = panel.locator('[data-slot="assistant-limit"]').getByRole("link", { name: "Manage usage" })
  await expect(manage).toHaveAttribute("href", "https://chatgpt.com/settings/usage")
  await expect(panel.getByRole("textbox", { name: "Message the assistant" })).toBeDisabled()
  // Opening the comments closes the assistant: one panel at a time.
  await page.getByRole("button", { name: /^Comments/ }).click()
  await expect(panel).toHaveCount(0)
})
