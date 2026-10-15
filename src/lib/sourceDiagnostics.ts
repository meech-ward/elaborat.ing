import type { DocumentSnapshot } from "@/features/document"

/**
 * Compile-check the current source outside the rendered view, so Source
 * mode surfaces the same actionable error the rendered pipeline would
 * show — even before the first visit to Rendered mode. Returns the error
 * message, or null when the source compiles. The source itself is never
 * modified; callers debounce and drop stale results. The MDX compiler loads
 * with the first check, so the project page does not download it before a
 * note opens.
 */
export async function diagnoseSource(
  text: string,
  format: DocumentSnapshot["format"],
): Promise<string | null> {
  // A compiler that cannot load (offline before it was cached) says nothing
  // about the note: no error until the next check can run.
  const compiler = await import("@/features/rendered/instrumentation").catch(() => null)
  if (!compiler) return null
  const { instrumentMarkdownSource, instrumentMdxSource } = compiler
  try {
    if (format === "md") {
      await instrumentMarkdownSource(text)
    } else {
      await instrumentMdxSource(text)
    }
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/**
 * The first `line:column` in an error message, as MDX writes them: leading
 * ("3:6: ..."), or in brackets ("(3:6-3:9)", "(3:6)").
 */
export function parseErrorPosition(message: string): { line: number; column: number } | null {
  const match = /(?:^|[\s(])(\d+):(\d+)(?:[\s:)-]|$)/.exec(message)
  if (!match) return null
  const line = Number(match[1])
  const column = Number(match[2])
  if (!Number.isInteger(line) || line < 1 || !Number.isInteger(column) || column < 1) return null
  return { line, column }
}
