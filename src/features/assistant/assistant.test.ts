import { describe, expect, test } from "bun:test"
import { argumentReader } from "./args"
import { runTool, type BridgeContext } from "./bridge"
import { Chat, type LiveDriver } from "./chat"
import type { AssistantHost } from "./host"
import { runTurn, type InputItem } from "./loop"
import { eventParser, readEvents } from "./sse"
import { statusOf } from "./status"

// The assistant's browser side: the stream reader, the argument reader, the
// tool bridge and the loop, with a stand-in workbench and keeper.

const sse = (events: Array<Record<string, unknown>>) => events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("")

function streamOf(chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk)
      controller.close()
    },
  })
}

async function collect(stream: ReadableStream<Uint8Array>) {
  const events: unknown[] = []
  for await (const event of readEvents(stream)) events.push(event)
  return events
}

describe("the stream reader", () => {
  const events = [
    { type: "response.output_text.delta", item_id: "msg_1", delta: "Café 🎉 \"quoted\"" },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: "{\"path\":" },
    { type: "response.completed", response: { output: [] } },
  ]
  const text = sse(events) + "data: [DONE]\n\n"

  test("reads the same events wherever the chunks split, also inside a character", async () => {
    const bytes = new TextEncoder().encode(text)
    for (let cut = 0; cut <= bytes.length; cut++) {
      expect(await collect(streamOf([bytes.slice(0, cut), bytes.slice(cut)]))).toEqual(events)
    }
  })

  test("takes CRLF and CR line ends, a CRLF split between chunks, comments and multi-line data", () => {
    const parser = eventParser()
    expect(parser.push(": keep-alive\r\ndata: {\"a\":\r")).toEqual([])
    expect(parser.push("\ndata: 1}\r\n\r")).toEqual([])
    expect(parser.push("\ndata: {\"b\":2}\r\r")).toEqual([{ a: 1 }])
    expect(parser.push("", true)).toEqual([{ b: 2 }])
  })
})

describe("the argument reader", () => {
  test("reads escapes, character by character too", () => {
    const raw = JSON.stringify({ path: "notes/a.md", content: 'line 1\nline "2" \\ café\ttab' })
    const whole = argumentReader()
    whole.push(raw)
    expect(whole.path).toBe("notes/a.md")
    expect(whole.content).toBe('line 1\nline "2" \\ café\ttab')
    expect(whole.contentDone).toBe(true)
    const bit = argumentReader()
    for (const char of raw) bit.push(char)
    expect(bit.content).toBe(whole.content)
    const escaped = argumentReader()
    escaped.push('{"path":"a\\/b.md","content":"caf\\u00e9\\n"}')
    expect(escaped.path).toBe("a/b.md")
    expect(escaped.content).toBe("café\n")
  })

  test("gives the content so far, and waits for both halves of a character split across pieces", () => {
    const reader = argumentReader()
    reader.push('{"path":"art/flow.excalidraw","content":"{\\"elements\\":[a\\ud8')
    expect(reader.path).toBe("art/flow.excalidraw")
    expect(reader.pathDone).toBe(true)
    expect(reader.content).toBe('{"elements":[a')
    expect(reader.contentDone).toBe(false)
    reader.push("3c\\udf")
    expect(reader.content).toBe('{"elements":[a')
    reader.push("89b")
    expect(reader.content).toBe('{"elements":[a🎉b')
    // A pair the server split between two pieces, unescaped.
    const raw = argumentReader()
    raw.push('{"content":"x\ud83c')
    expect(raw.content).toBe("x")
    raw.push('\udf89"}')
    expect(raw.content).toBe("x🎉")
  })

  test("reads either key order, and skips other values", () => {
    const reader = argumentReader()
    reader.push('{"note": [1, {"a": "}\\""}], "content": "hi", "path": "flows/b.d2"}')
    expect(reader.content).toBe("hi")
    expect(reader.path).toBe("flows/b.d2")
    const first = argumentReader()
    first.push('{"content":"partial')
    expect(first.path).toBeNull()
    expect(first.content).toBe("partial")
  })
})

type Tab = { text: string; dirty: boolean }

function fakeHost(tabs: Record<string, Tab> = {}) {
  const writes: string[] = []
  const host: AssistantHost = {
    projectId: "project",
    readOnly: null,
    listFiles: async () => Object.keys(tabs).map((path) => ({ path, kind: "note" as const, unsaved: tabs[path].dirty })),
    readFile: async (path) => (tabs[path] ? { path, content: tabs[path].text, version: 1, unsaved: tabs[path].dirty } : null),
    unsavedText: async (path) => (tabs[path]?.dirty ? tabs[path].text : null),
    show: async () => {},
    liveContainer: () => null,
    writeFile: async (path, content) => {
      writes.push(path)
      tabs[path] = { text: content, dirty: true }
      return { created: false }
    },
    listComments: async () => [],
  }
  return { host, tabs, writes }
}

describe("the tool bridge", () => {
  const context = (host: AssistantHost, answer = true, asked: string[] = []): BridgeContext => ({
    host,
    written: new Map(),
    confirm: async (message) => {
      asked.push(message)
      return answer
    },
  })

  test("a tool outside the four, or in another namespace, is refused and does nothing", async () => {
    const { host, writes } = fakeHost({ "a.md": { text: "A", dirty: false } })
    const refused = await runTool({ name: "delete_file", arguments: '{"path":"a.md"}' }, context(host))
    expect(refused.result).toBe("error")
    expect(JSON.parse(refused.output).error).toContain("no tool named delete_file")
    const elsewhere = await runTool({ name: "write_file", namespace: "other", arguments: '{"path":"a.md","content":"B"}' }, context(host))
    expect(elsewhere.result).toBe("error")
    expect(writes).toEqual([])
    const named = await runTool({ name: "read_file", namespace: "elaborating", arguments: '{"path":"a.md"}' }, context(host))
    expect(JSON.parse(named.output)).toMatchObject({ path: "a.md", content: "A", version: 1 })
  })

  test("a write over the person's unsaved edits asks first, and no leaves the tab as it was", async () => {
    const { host, tabs, writes } = fakeHost({ "notes/plan.mdx": { text: "My own edits", dirty: true } })
    const asked: string[] = []
    const kept = await runTool({ name: "write_file", arguments: JSON.stringify({ path: "notes/plan.mdx", content: "# The assistant's plan" }) }, context(host, false, asked))
    expect(asked).toEqual(["Replace your unsaved changes in notes/plan.mdx with the assistant's version?"])
    expect(kept.result).toBe("kept")
    expect(JSON.parse(kept.output)).toMatchObject({ written: false })
    expect(writes).toEqual([])
    expect(tabs["notes/plan.mdx"]).toEqual({ text: "My own edits", dirty: true })

    const replaced = await runTool({ name: "write_file", arguments: JSON.stringify({ path: "notes/plan.mdx", content: "# The assistant's plan" }) }, context(host, true))
    expect(replaced.result).toBe("done")
    expect(tabs["notes/plan.mdx"].text).toBe("# The assistant's plan")
  })

  test("writing again over its own unsaved version does not ask", async () => {
    const { host, writes } = fakeHost({ "a.md": { text: "Saved", dirty: false } })
    const asked: string[] = []
    const shared = context(host, false, asked)
    await runTool({ name: "write_file", arguments: JSON.stringify({ path: "a.md", content: "First" }) }, shared)
    await runTool({ name: "write_file", arguments: JSON.stringify({ path: "a.md", content: "Second" }) }, shared)
    expect(asked).toEqual([])
    expect(writes).toEqual(["a.md", "a.md"])
  })

  test("a drawing that is not a scene is refused before anything changes", async () => {
    const { host, writes } = fakeHost()
    const outcome = await runTool({ name: "write_file", arguments: JSON.stringify({ path: "art/flow.excalidraw", content: "not json" }) }, context(host))
    expect(outcome.result).toBe("error")
    expect(writes).toEqual([])
  })
})

const listFilesRound = (round: number) =>
  sse([
    { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: `fc_${round}`, call_id: `call_${round}`, name: "list_files", namespace: "elaborating", arguments: "" } },
    { type: "response.function_call_arguments.delta", item_id: `fc_${round}`, output_index: 0, delta: "{}" },
    { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: `fc_${round}`, call_id: `call_${round}`, name: "list_files", namespace: "elaborating", arguments: "{}" } },
    { type: "response.completed", response: { output: [{ type: "reasoning", id: `rs_${round}`, encrypted_content: "opaque" }, { type: "function_call", id: `fc_${round}`, call_id: `call_${round}`, name: "list_files", namespace: "elaborating", arguments: "{}" }] } },
  ])

describe("the loop", () => {
  test("sends back every output item, encrypted reasoning too, and stops at 25 tool calls in a turn", async () => {
    const bodies: Array<{ input: InputItem[] }> = []
    let ran = 0
    const result = await runTurn({
      history: [{ role: "user", content: "Look around" }],
      model: "gpt-sample",
      signal: new AbortController().signal,
      post: async (body) => {
        bodies.push(structuredClone(body))
        return new Response(streamOf([listFilesRound(bodies.length)]), { status: 200 })
      },
      hooks: {
        onText: () => {},
        onWrite: () => {},
        runCall: async () => {
          ran++
          return { tool: "list_files", path: null, result: "done", output: "{}" }
        },
      },
    })
    expect(result.status).toBe("capped")
    expect(ran).toBe(25)
    expect(bodies).toHaveLength(26)
    expect(bodies[1].input).toEqual([
      { role: "user", content: "Look around" },
      { type: "reasoning", id: "rs_1", encrypted_content: "opaque" },
      { type: "function_call", id: "fc_1", call_id: "call_1", name: "list_files", namespace: "elaborating", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "{}" },
    ])
    expect(JSON.parse(String(result.history.at(-1)!.output))).toEqual({ error: "Stopped: at most 25 tool calls in one turn." })
  })

  test("streams a write's content to the live view, then runs the call", async () => {
    const seen: string[] = []
    let posts = 0
    const write = sse([
      { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "write_file", arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"path":"notes/a.md"' },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: ',"content":"# Hel' },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: 'lo"}' },
      { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "write_file", arguments: '{"path":"notes/a.md","content":"# Hello"}' } },
      { type: "response.completed", response: { output: [] } },
    ])
    const answer = sse([
      { type: "response.output_text.delta", item_id: "msg_2", delta: "Done." },
      { type: "response.completed", response: { output: [{ type: "message", id: "msg_2", role: "assistant", content: [{ type: "output_text", text: "Done." }] }] } },
    ])
    const result = await runTurn({
      history: [{ role: "user", content: "Write a note" }],
      model: "gpt-sample",
      signal: new AbortController().signal,
      post: async () => new Response(streamOf([posts++ === 0 ? write : answer])),
      hooks: {
        onText: (_id, delta) => seen.push(`text ${delta}`),
        onWrite: (_id, path, content) => seen.push(`${path}: ${content}`),
        runCall: async (_id, call) => {
          seen.push(`run ${call.arguments}`)
          return { tool: "write_file", path: "notes/a.md", result: "done", output: "{}" }
        },
      },
    })
    expect(seen).toEqual(["notes/a.md: ", "notes/a.md: # Hel", "notes/a.md: # Hello", 'run {"path":"notes/a.md","content":"# Hello"}', "text Done."])
    expect(result.status).toBe("done")
    expect(posts).toBe(2)
  })

  test("a usage limit that arrives mid-stream shows the limit state", async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        streamOf([
          sse([
            { type: "response.output_text.delta", item_id: "msg_1", delta: "Working on it" },
            { type: "response.failed", response: { error: { code: "subscription_sharing_usage_limit_exceeded", message: "Limit reached." } } },
          ]),
        ]),
        { status: 200 },
      )) as unknown as typeof fetch
    try {
      const chat = new Chat()
      const live: LiveDriver = { start: () => {}, update: () => {}, finish: async () => {}, destroy: () => {} }
      await chat.send("Draw something", { model: "gpt-sample", host: fakeHost().host, confirm: async () => true, live })
      const state = chat.get()
      expect(state.running).toBe(false)
      expect(state.problem?.error).toBe("usage_limit")
      expect(state.entries.map((entry) => entry.text)).toEqual(["Draw something", "Working on it"])
      const ready = { kind: "ready" as const, status: { connected: true, plan: true, email: null, models: [{ slug: "gpt-sample", name: "GPT" }], problem: null } }
      expect(statusOf(ready, state.problem).status).toBe("limit")
    } finally {
      globalThis.fetch = original
    }
  })

  test("the keeper's errors map to the panel's states", () => {
    const ready = (problem: "not_eligible" | "unavailable" | null) => ({ kind: "ready" as const, status: { connected: true, plan: true, email: null, models: [], problem } })
    expect(statusOf(ready("not_eligible"), null).status).toBe("not-eligible")
    expect(statusOf(ready("unavailable"), null).status).toBe("unavailable")
    expect(statusOf(ready(null), { error: "reconnect", message: "" }).status).toBe("reconnect")
    expect(statusOf({ kind: "ready", status: { connected: false, plan: false, email: null, models: [], problem: null } }, null).status).toBe("not-connected")
  })
})
