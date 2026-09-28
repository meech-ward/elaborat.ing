import { isValidElement, type ReactElement, type ReactNode } from "react"
import { cn } from "@/lib/utils"

// No shadcn primitive fits: shadcn has no code view. This is the source
// pane's look from C5 screen 1 (the editor itself is Monaco, which takes the
// same font, sizes and colours from monacoTheme).

/** The syntax colours: headings, tags and keys, strings, keywords and numbers, fences. */
export type SourceTone = "head" | "key" | "str" | "kw" | "dim"

/**
 * A piece of a line: plain text, text in one of the syntax colours, or an
 * element, such as commented text in a CommentHighlight.
 */
export type SourcePart = string | readonly [tone: SourceTone, text: string] | ReactElement

const TONES: Record<SourceTone, string> = {
  head: "text-code-head",
  key: "text-code-key",
  str: "text-code-str",
  kw: "text-code-kw",
  dim: "text-dim",
}

/**
 * Source text with line numbers: 13px on 22px lines in the code font, the
 * numbers 22 wide in faint, 16 from the text, 14 above and below. The
 * current line has the lineHi fill across the pane. A long line wraps with
 * no number of its own. The numbers are decoration, drawn from a data
 * attribute as a code view on the web usually draws them: screen readers,
 * copying and contrast checks skip them.
 */
export function SourceLines({
  lines,
  currentLine,
  markers,
  className,
  "aria-label": ariaLabel,
}: {
  lines: readonly (readonly SourcePart[])[]
  /** The line the cursor is on, counting from 1. */
  currentLine?: number
  /** Something at the end of a line, by its number: a CommentMarker. */
  markers?: Readonly<Record<number, ReactNode>>
  className?: string
  "aria-label"?: string
}) {
  return (
    <pre
      aria-label={ariaLabel}
      className={cn("m-0 py-3.5 font-mono text-[13px] leading-[22px] whitespace-pre-wrap text-foreground", className)}
    >
      <code className="block">
        {lines.map((parts, index) => (
          <span key={index} data-current={index + 1 === currentLine || undefined} className="flex gap-4 data-current:bg-line-hi">
            <span
              aria-hidden="true"
              data-line={index + 1}
              className="w-[22px] shrink-0 text-right text-faint select-none before:content-[attr(data-line)]"
            />
            <span className="min-w-0 flex-1 break-words">
              {parts.map((part, at) =>
                typeof part === "string" ? (
                  part
                ) : isValidElement(part) ? (
                  <span key={at}>{part}</span>
                ) : (
                  <span key={at} className={TONES[part[0]]}>
                    {part[1]}
                  </span>
                ),
              )}
            </span>
            {markers?.[index + 1] && <span className="flex h-[22px] shrink-0 items-center pr-3">{markers[index + 1]}</span>}
          </span>
        ))}
      </code>
    </pre>
  )
}
