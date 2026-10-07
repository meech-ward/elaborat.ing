import { parseDrawingFile } from "@/features/drawings/parse"
import { scenesEqual } from "@/features/drawings/serialize"
import { byteLength, MAX_FILE_BYTES } from "@/features/project-storage/model"
import { kindForPath } from "@/features/workbench/session"
import { toolNameOf, type ToolName } from "../../../supabase/functions/_shared/chatgpt/tools.ts"
import type { AssistantHost } from "./host"

/**
 * The tool bridge: runs the assistant's function calls through the app's
 * own operations (the workbench's AssistantHost), as the person. Only the
 * four tools exist; any other name is refused and does nothing. A write
 * never saves: it lands as an unsaved edit, and over the person's own
 * unsaved edits only once they say yes.
 */

export type ToolCall = { name: unknown; namespace?: unknown; arguments: string }

export type ToolOutcome = {
  tool: ToolName | null
  path: string | null
  /** What the model is told, as a JSON string. */
  output: string
  /** done; kept (the person kept their own changes); or error. */
  result: "done" | "kept" | "error"
}

export type BridgeContext = {
  host: AssistantHost
  /** Asks the person (confirmAction in the app); true to go ahead. */
  confirm: (message: string) => Promise<boolean>
  /** What the assistant last wrote to each file in this chat: a write over its own unsaved version does not ask. */
  written: Map<string, string>
}

/** The largest file the assistant reads, in characters: it rewrites files whole, so it never reads part of one. */
export const MAX_READ_CHARS = 400_000

const failed = (tool: ToolName | null, path: string | null, message: string): ToolOutcome => ({ tool, path, output: JSON.stringify({ error: message }), result: "error" })
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Whether the tab's unsaved text is still the version the assistant wrote (a drawing compares as a scene: the canvas writes it out again). */
function sameEdit(path: string, current: string, written: string | undefined): boolean {
  if (written === undefined) return false
  if (kindForPath(path) === "drawing") {
    try {
      return scenesEqual(parseDrawingFile(current, path).scene, parseDrawingFile(written, path).scene)
    } catch {
      return false
    }
  }
  return current.replaceAll("\r\n", "\n") === written.replaceAll("\r\n", "\n")
}

export async function runTool(call: ToolCall, context: BridgeContext): Promise<ToolOutcome> {
  const tool = toolNameOf(call)
  if (!tool) return failed(null, null, `There is no tool named ${String(call.name)}. Use list_files, read_file, write_file or list_comments.`)
  let args: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(call.arguments || "{}")
    args = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {}
  } catch {
    return failed(tool, null, "The arguments were not valid JSON.")
  }
  const path = typeof args.path === "string" && args.path.trim() ? args.path.trim() : null
  const { host } = context
  try {
    switch (tool) {
      case "list_files":
        return { tool, path: null, result: "done", output: JSON.stringify({ files: await host.listFiles() }) }
      case "read_file": {
        if (!path) return failed(tool, null, "read_file needs a path.")
        const file = await host.readFile(path)
        if (!file) return failed(tool, path, `${path} is not in this project.`)
        if (file.content.length > MAX_READ_CHARS) return failed(tool, path, `${path} is too large for the assistant to read (${file.content.length} characters).`)
        return { tool, path, result: "done", output: JSON.stringify({ path, version: file.version, unsaved_changes: file.unsaved, content: file.content }) }
      }
      case "list_comments": {
        if (!path) return failed(tool, null, "list_comments needs a path.")
        const threads = await host.listComments(path)
        return { tool, path, result: "done", output: JSON.stringify(typeof threads === "string" ? { threads: [], note: threads } : { threads }) }
      }
      case "write_file": {
        if (host.readOnly) return failed(tool, path, `This project can't be changed: ${host.readOnly}`)
        if (!path || typeof args.content !== "string") return failed(tool, path, "write_file needs a path and the complete content.")
        const content = args.content
        if (byteLength(content) > MAX_FILE_BYTES) return failed(tool, path, "That is larger than a file can be (2 MB).")
        if (kindForPath(path) === "drawing") {
          try {
            parseDrawingFile(content, path)
          } catch (error) {
            return failed(tool, path, `That is not a drawing elaborat.ing can open (${message(error)}). Write the whole Excalidraw scene as JSON.`)
          }
        }
        const unsaved = await host.unsavedText(path)
        if (unsaved !== null && !sameEdit(path, unsaved, context.written.get(path))) {
          const replace = await context.confirm(`Replace your unsaved changes in ${path} with the assistant's version?`)
          if (!replace) {
            return { tool, path, result: "kept", output: JSON.stringify({ written: false, note: `The person kept their own unsaved changes in ${path}. Nothing was written.` }) }
          }
        }
        const { created } = await host.writeFile(path, content)
        context.written.set(path, content)
        return {
          tool,
          path,
          result: "done",
          output: JSON.stringify({ written: true, created, note: `${path} shows your version as unsaved changes. The person saves or discards it.` }),
        }
      }
    }
  } catch (error) {
    return failed(tool, path, message(error))
  }
}
