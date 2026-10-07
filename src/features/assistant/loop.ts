import { planErrorFor, type PlanError } from "../../../supabase/functions/_shared/chatgpt/responses.ts"
import { toolNameOf } from "../../../supabase/functions/_shared/chatgpt/tools.ts"
import { keeperError } from "./api"
import { argumentReader, type ArgumentReader } from "./args"
import type { ToolCall, ToolOutcome } from "./bridge"
import { readEvents } from "./sse"

/**
 * The agent loop, in the browser, as the person: send the chat so far to
 * /chatgpt/responses, read the stream, run each function call through the
 * app's own operations, then send everything the model wrote (its encrypted
 * reasoning too) and the calls' outputs back, until it answers without a
 * call. At most 25 calls a turn; aborting the signal stops it.
 */

export const MAX_TOOL_CALLS = 25

export type InputItem = Record<string, unknown>

export type TurnHooks = {
  /** The assistant's words, as they come, by message item. */
  onText(id: string, delta: string): void
  /** A write_file call whose path has arrived, with its content so far, each time more comes. */
  onWrite(id: string, path: string, content: string): void
  /** Runs a finished call. */
  runCall(id: string, call: ToolCall): Promise<ToolOutcome>
}

export type TurnResult = { status: "done" | "capped"; history: InputItem[] } | { status: "failed"; history: InputItem[]; error: PlanError }

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" ? (value as Record<string, unknown>) : {})

export async function runTurn(options: {
  /** The chat so far, ending with the person's new message. */
  history: InputItem[]
  model: string
  post: (body: { model: string; input: InputItem[] }, signal: AbortSignal) => Promise<Response>
  signal: AbortSignal
  hooks: TurnHooks
  maxToolCalls?: number
}): Promise<TurnResult> {
  const { model, signal, hooks } = options
  const max = options.maxToolCalls ?? MAX_TOOL_CALLS
  let history = options.history
  let calls = 0
  for (let round = 0; ; round++) {
    const response = await options.post({ model, input: history }, signal)
    if (!response.ok || !response.body) {
      return { status: "failed", history, error: keeperError(response.status, await response.json().catch(() => null)) }
    }
    const done = new Map<number, InputItem>()
    const calling = new Map<string, { reader: ArgumentReader; item: Record<string, unknown> }>()
    const outputs: InputItem[] = []
    let completed: InputItem[] | null = null
    let failure: PlanError | null = null
    let capped = false
    const key = (id: unknown) => `${round}:${String(id)}`
    for await (const event of readEvents(response.body)) {
      switch (event.type) {
        case "response.output_text.delta":
          hooks.onText(key(event.item_id), typeof event.delta === "string" ? event.delta : "")
          break
        case "response.output_item.added": {
          const item = record(event.item)
          if (item.type === "function_call") calling.set(String(item.id), { reader: argumentReader(), item })
          break
        }
        case "response.function_call_arguments.delta": {
          const entry = calling.get(String(event.item_id))
          if (!entry) break
          entry.reader.push(typeof event.delta === "string" ? event.delta : "")
          const path = entry.reader.path
          if (toolNameOf(entry.item) === "write_file" && path !== null && entry.reader.pathDone) hooks.onWrite(key(event.item_id), path, entry.reader.content ?? "")
          break
        }
        case "response.output_item.done": {
          const item = record(event.item)
          done.set(typeof event.output_index === "number" ? event.output_index : done.size, item)
          if (item.type !== "function_call") break
          calls++
          let output: string
          if (calls > max) {
            capped = true
            output = JSON.stringify({ error: `Stopped: at most ${max} tool calls in one turn.` })
          } else {
            const outcome = await hooks.runCall(key(item.id), { name: item.name, namespace: item.namespace, arguments: typeof item.arguments === "string" ? item.arguments : "" })
            output = outcome.output
          }
          outputs.push({ type: "function_call_output", call_id: item.call_id, output })
          break
        }
        case "response.completed": {
          const output = record(event.response).output
          completed = Array.isArray(output) ? (output as InputItem[]) : []
          break
        }
        case "response.failed":
          failure = planErrorFor(0, { error: record(event.response).error ?? null })
          break
        case "response.incomplete":
          failure = { error: "error", message: "ChatGPT stopped before finishing its answer." }
          break
        case "error":
          failure = planErrorFor(0, event)
          break
      }
    }
    if (failure) return { status: "failed", history, error: failure }
    if (completed === null) return { status: "failed", history, error: { error: "error", message: "The answer was cut off. Try again." } }
    // Everything the model wrote goes back in, its encrypted reasoning too, then what each call returned.
    const produced = completed.length > 0 ? completed : [...done.entries()].sort(([a], [b]) => a - b).map(([, item]) => item)
    history = [...history, ...produced, ...outputs]
    if (outputs.length === 0) return { status: "done", history }
    if (capped) return { status: "capped", history }
  }
}
