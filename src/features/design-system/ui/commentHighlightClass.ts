import "./commentHighlight.css"

/**
 * The class names that give text CommentHighlight's look where the library
 * does not render it (commentHighlight.css): the source editor's decorations
 * and the rendered note's. `active` is the thread open in the panel; `flash`
 * pulses once when the panel shows a thread's text.
 */
export function commentHighlightClass({ active = false, flash = false }: { active?: boolean; flash?: boolean } = {}): string {
  return ["comment-highlight", active && "comment-highlight-active", flash && "comment-highlight-flash"].filter(Boolean).join(" ")
}
