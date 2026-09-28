import { cva } from "class-variance-authority"
import { MessageSquare, MessageSquarePlus, Unlink } from "lucide-react"
import type { ComponentProps } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { ButtonShortcut } from "./ButtonShortcut"
import type { CommentsSize } from "./commentTypes"
import { Hint } from "./Hint"
import type { Shortcut } from "./shortcuts"

// Where comments show on a file: a count in a gutter, a highlighted range of
// text, a pin on a drawing's element, and the Comment button over a
// selection. No shadcn primitive is a count pin or a text highlight: the
// markers are Buttons restyled, and the highlight is a <mark>.

/**
 * Where threads are, as a button that opens them. `gutter`: a small pill
 * (18 high, radius 5, 11px mono) in accentSoft beside a line or a heading.
 * `element`: a speech-bubble pin on a drawing (24 across, the accent with
 * its text colour and a 1px edge in the accent line, a ring of the panel
 * colour and the island shadow); its bottom-left corner is the point it
 * marks, so place that corner on the spot. `active` is the thread that is
 * open in the panel. Both reach 40px as touch targets without growing.
 *
 * The count is of threads, as the Comments button counts them, and shows
 * only from 2: one thread is the icon alone.
 */
export const commentMarkerVariants = cva(
  "relative inline-flex shrink-0 cursor-pointer items-center justify-center font-mono font-semibold tabular-nums transition-colors outline-none select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-ring motion-reduce:transition-none pointer-coarse:after:absolute pointer-coarse:after:content-['']",
  {
    variants: {
      variant: {
        gutter:
          "h-[18px] min-w-[26px] gap-[3px] rounded-chip px-1 text-[11px] [&_svg]:size-[11px] pointer-coarse:after:-inset-x-2 pointer-coarse:after:-inset-y-[11px]",
        element:
          "size-6 rounded-full rounded-bl-[4px] border border-accent-line text-[11px] shadow-island ring-2 ring-panel pointer-coarse:after:-inset-2 [&_svg]:size-3",
      },
      active: { true: "", false: "" },
    },
    compoundVariants: [
      { variant: "gutter", active: false, className: "bg-accent-soft text-accent-soft-text hover:bg-[color-mix(in_oklab,var(--accent-soft)_88%,var(--accent))]" },
      { variant: "gutter", active: true, className: "bg-primary text-primary-foreground shadow-[inset_0_0_0_1px_var(--focus)]" },
      { variant: "element", active: false, className: "bg-primary text-primary-foreground hover:bg-[color-mix(in_oklab,var(--accent)_88%,var(--text))]" },
      { variant: "element", active: true, className: "size-7 bg-primary text-[12px] text-primary-foreground ring-4 ring-accent-soft" },
    ],
    defaultVariants: { variant: "gutter", active: false },
  },
)

export function CommentMarker({
  count,
  label,
  variant = "gutter",
  active = false,
  className,
  ...props
}: Omit<ComponentProps<"button">, "children" | "aria-label"> & {
  /** How many threads it opens. */
  count: number
  /** What the button opens, for screen readers: "2 threads on Steps". */
  label: string
  variant?: "gutter" | "element"
  active?: boolean
}) {
  return (
    <button
      type="button"
      data-slot="comment-marker"
      data-variant={variant}
      data-active={active || undefined}
      aria-label={label}
      title={label}
      className={cn(commentMarkerVariants({ variant, active }), className)}
      {...props}
    >
      {(variant === "gutter" || count < 2) && <MessageSquare aria-hidden="true" strokeWidth={2.4} />}
      {count > 1 && count}
    </button>
  )
}

/**
 * Commented text: a faint wash (10%) of the accent line over a dotted 2px
 * underline in the accent line, which shows at 3:1 in every palette. The
 * dots keep it apart from the selection's accentSoft and from links, which
 * are solid. The open thread's text (`active`) takes a stronger wash (22%)
 * and a solid underline. The source and rendered views can use the class on
 * their own decorations.
 */
export const commentHighlightVariants = cva(
  "rounded-[2px] text-inherit underline decoration-accent-line decoration-2 underline-offset-[3px] [text-decoration-skip-ink:none] transition-colors motion-reduce:transition-none",
  {
    variants: {
      active: {
        false: "bg-[color-mix(in_oklab,var(--focus)_10%,transparent)] decoration-dotted",
        true: "bg-[color-mix(in_oklab,var(--focus)_22%,transparent)] decoration-solid",
      },
    },
    defaultVariants: { active: false },
  },
)

export function CommentHighlight({ active = false, className, ...props }: ComponentProps<"mark"> & { active?: boolean }) {
  return <mark data-slot="comment-highlight" data-active={active || undefined} className={cn(commentHighlightVariants({ active }), className)} {...props} />
}

/**
 * The Comment button that floats by a selection or a drawing's selected
 * element: an island (the island fill, radius 10, the island shadow and
 * ring) holding the icon and the word, with the key when the view has one.
 * 32 high (`touch`: 40, 15px).
 */
export function CommentActionButton({
  size = "default",
  shortcut,
  className,
  children = "Comment",
  ...props
}: Omit<ComponentProps<typeof Button>, "variant" | "size"> & { size?: CommentsSize; shortcut?: Shortcut }) {
  return (
    <Button
      variant="ghost"
      aria-keyshortcuts={shortcut?.aria}
      className={cn(
        "rounded-tile bg-island text-tool-ink shadow-island hover:bg-[color-mix(in_oklab,var(--seg)_60%,var(--island))] hover:text-tool-ink active:bg-seg",
        size === "touch" ? "h-10 gap-2 px-3.5 text-[15px] [&_svg:not([class*='size-'])]:size-5" : "h-8 gap-1.5 px-2.5",
        className,
      )}
      {...props}
    >
      <MessageSquarePlus aria-hidden="true" />
      {children}
      {shortcut && <ButtonShortcut className="text-dim pointer-coarse:hidden">{shortcut.label}</ButtonShortcut>}
    </Button>
  )
}

/**
 * A thread whose text, heading or element is gone: the warning badge with
 * the unlink icon. Next to it the thread says what is gone, and the quote
 * it was made on shows struck through.
 */
export function DetachedBadge({ className, ...props }: Omit<ComponentProps<typeof Badge>, "variant" | "children">) {
  return (
    <Badge variant="warning" className={className} {...props}>
      <Unlink data-icon="inline-start" aria-hidden="true" />
      Detached
    </Badge>
  )
}

/**
 * Opens and closes the comments: in the editor's header, the icon and the
 * open count as a ghost button (30 high, radius 8, muted; seg while the
 * panel is open, `pressed`), with its key in the tooltip. On phones
 * (`touch`) the round 40 button over the file, with the count on an accent
 * bubble at its top right.
 */
export function CommentsButton({
  count,
  pressed = false,
  size = "default",
  label = "Comments",
  shortcut,
  className,
  ...props
}: Omit<ComponentProps<typeof Button>, "variant" | "size" | "children" | "aria-label"> & {
  count: number
  pressed?: boolean
  size?: CommentsSize
  label?: string
  /** The key that shows and hides the comments (commentsShortcut). */
  shortcut?: Shortcut
}) {
  const name = count > 0 ? `${label}, ${count} open` : label
  if (size === "touch") {
    return (
      <Button
        variant="outline"
        size="icon-lg"
        aria-label={name}
        aria-pressed={pressed}
        className={cn(
          "relative rounded-full border-panel-border bg-panel text-foreground shadow-[0_6px_18px_var(--shadow)] hover:bg-[color-mix(in_oklab,var(--seg)_50%,var(--panel))] hover:text-foreground active:bg-seg aria-pressed:bg-accent-soft aria-pressed:text-accent-soft-text",
          className,
        )}
        {...props}
      >
        <MessageSquare aria-hidden="true" />
        {count > 0 && (
          <span
            aria-hidden="true"
            className="absolute -top-1 -right-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-pill bg-primary px-1 font-mono text-[11px] font-semibold text-primary-foreground ring-2 ring-panel"
          >
            {count}
          </span>
        )}
      </Button>
    )
  }
  return (
    <Hint label={label} shortcut={shortcut?.label}>
      <Button
        variant="ghost"
        size="sm"
        aria-label={name}
        aria-pressed={pressed}
        aria-keyshortcuts={shortcut?.aria}
        className={cn(
          "h-[30px] gap-1.5 rounded-tool px-2 font-mono text-xs font-medium tabular-nums aria-pressed:bg-seg aria-pressed:text-foreground pointer-coarse:h-10",
          className,
        )}
        {...props}
      >
        <MessageSquare aria-hidden="true" />
        {count > 0 && count}
      </Button>
    </Hint>
  )
}
