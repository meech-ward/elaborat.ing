import { cva } from "class-variance-authority"
import { cn } from "@/lib/utils"

// No shadcn primitive fits: Badge is a filled pill, and this is a single
// letter in the file kind's colour with no fill.

/** What a file holds, as the app's file kinds name it. */
export type FileKind = "note" | "drawing" | "diagram" | "text"

const LETTERS: Record<FileKind, string> = { note: "M", drawing: "D", diagram: "2", text: "" }

/**
 * A file's kind as one letter in its kind colour: M for notes, D for
 * drawings, 2 for D2 diagrams, and an empty slot of the same width for other
 * files so names line up. 16 wide, 700 11px mono (`touch`: 18 wide, 12px).
 * Decoration only: the name says the same, so screen readers skip it.
 */
export const kindBadgeVariants = cva("shrink-0 text-center font-mono font-bold", {
  variants: {
    kind: {
      note: "text-note",
      drawing: "text-drawing",
      diagram: "text-diagram",
      text: "",
    },
    size: {
      default: "w-4 text-[11px]",
      touch: "w-[18px] text-xs",
    },
  },
  defaultVariants: { size: "default" },
})

export function KindBadge({
  kind,
  size = "default",
  className,
}: {
  kind: FileKind
  size?: "default" | "touch"
  className?: string
}) {
  return (
    <span aria-hidden="true" data-kind={kind} className={cn(kindBadgeVariants({ kind, size }), className)}>
      {LETTERS[kind]}
    </span>
  )
}
