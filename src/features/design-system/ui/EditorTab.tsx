import type { ComponentProps, CSSProperties, ReactNode } from "react"
import { X } from "lucide-react"
import { TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import { DirtyDot } from "./StatusDot"

type TabProps = Omit<ComponentProps<typeof TabsTrigger>, "value" | "children" | "className">

/**
 * One open file in the editor's top line: the shadcn tab (Base UI owns the
 * tab role, selection, roving focus and arrow keys), 32 high with radius 9,
 * the kind badge, the name in 13px 500 muted, and the 7px unsaved dot. The
 * active tab sits on the seg fill in the text colour at 600. Use it inside
 * TabLine, or inside the Tabs and TabsList primitives.
 *
 * With `onClose`, a close mark takes the kind badge's place on hover and on
 * keyboard focus (on the active tab on touch screens), so tabs keep their
 * width and the name and unsaved dot stay in view; the Delete key closes the
 * focused tab. A tab may hold nothing interactive, so the mark is a pointer
 * target only. (KindBadge keeps an empty slot for other files, so every tab
 * has room for it.)
 */
export function EditorTab({
  value,
  name,
  badge,
  dirty = false,
  label,
  onClose,
  className,
  onKeyDown,
  ...props
}: TabProps & {
  value: string
  /** The file name the tab shows. */
  name: string
  /** The kind badge before the name (M, D, 2). */
  badge?: ReactNode
  dirty?: boolean
  /** An accessible name in place of the shown one, such as the file's path. */
  label?: string
  onClose?: () => void
  className?: string
}) {
  return (
    <TabsTrigger
      value={value}
      data-tab-value={value}
      aria-label={label && (dirty ? `${label}, unsaved changes` : label)}
      aria-keyshortcuts={onClose ? "Delete" : undefined}
      onKeyDown={(event) => {
        onKeyDown?.(event)
        if (!onClose || event.key !== "Delete") return
        event.preventDefault()
        onClose()
      }}
      className={cn(
        // --tab-fill is the tab's fill under the pointer or when active; the
        // close mark takes it so it hides the badge under it.
        "group/tab relative flex h-8 max-w-60 shrink-0 cursor-default items-center gap-[7px] rounded-button px-2.5 text-[13px] font-medium whitespace-nowrap text-muted-foreground outline-none select-none [--tab-fill:color-mix(in_oklab,var(--seg)_60%,var(--panel))] hover:bg-(--tab-fill) hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring data-active:bg-seg data-active:font-semibold data-active:text-foreground data-active:[--tab-fill:var(--seg)] pointer-coarse:h-10",
        className,
      )}
      {...props}
    >
      {badge}
      <span className="min-w-0 truncate">{name}</span>
      {dirty && <DirtyDot label={label ? undefined : "Unsaved changes"} />}
      {onClose && (
        <span
          aria-hidden="true"
          data-slot="tab-close"
          title="Close"
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            onClose()
          }}
          className="absolute top-1/2 left-[9px] grid size-[18px] -translate-y-1/2 cursor-pointer place-items-center rounded-[5px] bg-(--tab-fill) text-muted-foreground opacity-0 group-hover/tab:opacity-100 group-focus-visible/tab:opacity-100 group-data-active/tab:[@media(hover:none)]:opacity-100 hover:bg-[color-mix(in_oklab,var(--text)_12%,var(--tab-fill))] hover:text-foreground"
        >
          <X className="size-3" strokeWidth={2.25} />
        </span>
      )}
    </TabsTrigger>
  )
}

/**
 * A tab being dragged to a new place: a copy of the active tab (the seg fill,
 * the text colour at 600) with a 1px panel-border ring and the panel shadow,
 * which follows the pointer while the tab's own place stays empty. Fixed to
 * the viewport: give it `left`, `top`, `width` and `height` in `style`, and
 * render it into the body with a portal so the tab line's clipping does not
 * cut it. `settling` slides it into the tab's new place (instantly when
 * motion is reduced). Decoration only: screen readers skip it.
 */
export function EditorTabGhost({
  name,
  badge,
  dirty = false,
  settling = false,
  className,
  style,
}: {
  name: string
  badge?: ReactNode
  dirty?: boolean
  settling?: boolean
  className?: string
  style?: CSSProperties
}) {
  return (
    <div
      aria-hidden="true"
      data-slot="tab-ghost"
      data-settling={settling || undefined}
      style={style}
      className={cn(
        "pointer-events-none fixed z-100 box-border flex items-center gap-[7px] rounded-button border border-border bg-seg px-2.5 text-[13px] font-semibold whitespace-nowrap text-foreground shadow-panel data-settling:transition-[left] data-settling:duration-160 data-settling:ease-[cubic-bezier(.2,.8,.2,1)] motion-reduce:transition-none",
        className,
      )}
    >
      {badge}
      <span className="min-w-0 truncate">{name}</span>
      {dirty && <DirtyDot />}
    </div>
  )
}
