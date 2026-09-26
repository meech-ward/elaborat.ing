import type { DocumentSnapshot } from "@/features/document"
import { instrumentMarkdownSource, instrumentMdxSource } from "@/features/rendered/instrumentation"

/**
 * Compile-check the current source outside the rendered view, so Source
 * mode surfaces the same actionable error the rendered pipeline would
 * show — even before the first visit to Rendered mode. Returns the error
 * message, or null when the source compiles. The source itself is never
 * modified; callers debounce and drop stale results.
 */
export async function diagnoseSource(
  text: string,
  format: DocumentSnapshot["format"],
): Promise<string | null> {
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
