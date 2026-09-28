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
