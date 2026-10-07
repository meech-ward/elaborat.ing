import type { AssistantEntry } from "@/features/design-system"
import type { PlanError } from "../../../supabase/functions/_shared/chatgpt/responses.ts"
import { toolNameOf, type ToolName } from "../../../supabase/functions/_shared/chatgpt/tools.ts"
import { post } from "./api"
import { runTool, type BridgeContext, type ToolCall } from "./bridge"
import type { AssistantHost } from "./host"
import { runTurn, type InputItem } from "./loop"

/**
 * One chat with the assistant per project, kept in memory while the page is
 * open (New chat clears it; a reload starts again). It outlives the panel,
 * so a turn goes on with the panel closed.
 */

/** The live view of a file being written (live.ts): it covers the editor while the content streams. */
export type LiveDriver = {
  start(id: string, path: string): void
  update(id: string, content: string): void
  finish(id: string): Promise<void>
  destroy(id: string): void
}

export type ChatState = {
  entries: AssistantEntry[]
  history: InputItem[]
  running: boolean
  /** The last turn's error, until the next message. */
  problem: PlanError | null
  /** A file being written now (a phone's sheet gets out of its way). */
  writing: string | null
  announcement: string
}

const EMPTY: ChatState = { entries: [], history: [], running: false, problem: null, writing: null, announcement: "" }

const VERBS: Record<ToolName, { running: string; done: string; kept: string; error: string }> = {
  list_files: { running: "Listing files", done: "Listed files", kept: "Listed files", error: "Could not list files" },
  read_file: { running: "Reading", done: "Read", kept: "Read", error: "Could not read" },
  write_file: { running: "Writing", done: "Wrote", kept: "Kept your changes in", error: "Could not write" },
  list_comments: { running: "Reading comments on", done: "Read comments on", kept: "Read comments on", error: "Could not read comments on" },
}

function pathOf(call: ToolCall): string | undefined {
  try {
    const args: unknown = JSON.parse(call.arguments || "{}")
    const path = args && typeof args === "object" ? (args as { path?: unknown }).path : undefined
    return typeof path === "string" && path ? path : undefined
  } catch {
    return undefined
  }
}

export class Chat {
  private state: ChatState = EMPTY
  private readonly listeners = new Set<() => void>()
  private abort: AbortController | null = null
  /** What the assistant last wrote to each file in this chat. */
  private readonly written = new Map<string, string>()

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  readonly get = (): ChatState => this.state

  private set(change: Partial<ChatState> | ((state: ChatState) => Partial<ChatState>)) {
    this.state = { ...this.state, ...(typeof change === "function" ? change(this.state) : change) }
    for (const listener of this.listeners) listener()
  }

  private entry(id: string, make: () => AssistantEntry, change: (entry: AssistantEntry) => AssistantEntry) {
    this.set((state) => {
      const index = state.entries.findIndex((entry) => entry.id === id)
      if (index === -1) return { entries: [...state.entries, change(make())] }
      const entries = [...state.entries]
      entries[index] = change(entries[index])
      return { entries }
    })
  }

  /** Clears the chat (and stops a turn that is running). */
  newChat() {
    this.stop()
    this.written.clear()
    this.state = EMPTY
    for (const listener of this.listeners) listener()
  }

  stop() {
    this.abort?.abort()
  }

  /** Sends the person's message and runs the turn to its end. */
  async send(text: string, options: { model: string; host: AssistantHost; confirm: (message: string) => Promise<boolean>; live: LiveDriver }) {
    if (this.state.running) return
    const abort = new AbortController()
    this.abort = abort
    const user = { role: "user", content: text }
    this.set((state) => ({
      entries: [...state.entries, { id: crypto.randomUUID(), kind: "user", text }],
      history: [...state.history, user],
      running: true,
      problem: null,
      announcement: "",
    }))
    const context: BridgeContext = { host: options.host, confirm: options.confirm, written: this.written }
    // Write calls whose live view started, by call.
    const live = new Set<string>()
    const step = (id: string, tool: ToolName | null, path: string | undefined, state: "running" | "done" | "kept" | "error") => {
      const verbs = tool ? VERBS[tool] : null
      const text = verbs ? verbs[state] : "Refused a tool that does not exist"
      this.entry(id, () => ({ id, kind: "step", text, path, state }), () => ({ id, kind: "step", text, path, state }))
    }
    let history = this.state.history
    try {
      const result = await runTurn({
        history,
        model: options.model,
        signal: abort.signal,
        post: (body, signal) => post("/chatgpt/responses", body, signal),
        hooks: {
          onText: (id, delta) => {
            if (!delta) return
            this.entry(id, () => ({ id, kind: "assistant", text: "" }), (entry) => ({ ...entry, text: entry.text + delta }))
          },
          onWrite: (id, path, content) => {
            if (!live.has(id)) {
              live.add(id)
              step(id, "write_file", path, "running")
              this.set({ writing: path, announcement: `Writing ${path}` })
              void options.host.show(path)
              options.live.start(id, path)
            }
            options.live.update(id, content)
          },
          runCall: async (id, call) => {
            const tool = toolNameOf(call)
            const path = pathOf(call)
            const writing = live.has(id)
            if (!writing) step(id, tool, path, "running")
            try {
              if (writing) await options.live.finish(id)
              const outcome = await runTool(call, context)
              step(id, tool, path, outcome.result)
              if (tool === "write_file" && outcome.result === "done") this.set({ announcement: `Wrote ${path ?? "the file"}. Save it to keep it.` })
              return outcome
            } finally {
              if (writing) {
                options.live.destroy(id)
                live.delete(id)
                this.set({ writing: null })
              }
            }
          },
        },
      })
      history = result.history
      if (result.status === "failed") this.set({ problem: result.error })
      if (result.status === "capped") this.set((state) => ({ entries: [...state.entries, { id: crypto.randomUUID(), kind: "note", text: "Stopped after 25 steps. Send a message to go on." }] }))
    } catch (error) {
      const stopped = abort.signal.aborted
      this.set((state) => ({
        entries: [...state.entries, { id: crypto.randomUUID(), kind: "note", text: stopped ? "Stopped." : "The connection to ChatGPT was lost." }],
        problem: stopped ? null : { error: "error", message: error instanceof Error ? error.message : String(error) },
      }))
    } finally {
      for (const id of live) options.live.destroy(id)
      if (this.abort === abort) this.abort = null
      // A chat cleared while this turn ran stays cleared.
      if (this.state.running) this.set({ history, running: false, writing: null })
    }
  }
}

const chats = new Map<string, Chat>()

/** The project's chat, the same one each time the panel opens. */
export function chatFor(projectId: string): Chat {
  let chat = chats.get(projectId)
  if (!chat) chats.set(projectId, (chat = new Chat()))
  return chat
}
