import { useCallback, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from "react"
import { MoreHorizontal } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Tabs, TabsList } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import { ActionContextMenu, ActionMenu, type MenuEntry } from "./ActionMenu"
import { EditorTab } from "./EditorTab"
import { DirtyDot } from "./StatusDot"
import { clippedTabs, revealStart, type TabBox } from "./tabOverflow"

export type TabLineItem = {
  value: string
  /** The file name the tab shows. */
  name: string
  /** The kind badge before the name. */
  badge?: ReactNode
  dirty?: boolean
  /** An accessible name in place of the name, such as the file's path. */
  label?: string
  /** Shown after the name in the "+N" menu, such as the folder path. */
  detail?: string
}

/** A tab being dragged: its place stays empty, and the other tabs move by their offsets. */
export type TabLineDrag = {
  value: string
  offsets: Readonly<Record<string, number>>
  /** The other tabs slide to their new places rather than jump. */
  slide: boolean
}

type TabExtras = Omit<ComponentProps<typeof EditorTab>, "value" | "name" | "badge" | "dirty" | "label" | "onClose">

/**
 * The open files as a line of EditorTabs, 2 apart, on the shadcn tabs. Tabs
 * that don't fit stay in the tab list (and the accessibility tree) but out
 * of view, and "+N" right after the last tab in view lists them in a menu;
 * picking one opens it and brings it into view. The active tab is always in
 * view, and so is a tab reached with the arrow keys.
 *
 * With `actions`, each tab has a menu of its file's actions: on right-click
 * (a long press on touch screens), and from "..." at the active tab's right
 * end, shown while the pointer is over the tab or the keyboard is on it (and
 * always on touch screens); the tab then grows to make room for it. A tab may hold nothing interactive, so "..." is
 * the next stop after the tab list. The entries are read when a menu opens.
 *
 * TabLine is only the tab list: tab panels, if any, belong to the caller.
 * `withinTabs` leaves out TabLine's own Tabs root, for a caller whose Tabs
 * root holds the panels too (its value and changes then rule).
 */
export function TabLine({
  items,
  value,
  onValueChange,
  onClose,
  actions,
  actionsLabel = "File actions",
  withinTabs = false,
  listProps,
  tabProps,
  drag = null,
  "aria-label": ariaLabel = "Open files",
  className,
}: {
  items: readonly TabLineItem[]
  /** The active tab's value, or null when no file is open. */
  value: string | null
  onValueChange: (value: string) => void
  onClose?: (value: string) => void
  /** A tab's menu entries, read when its menu opens. */
  actions?: (value: string) => readonly MenuEntry[]
  /** The name of the "..." button and of the menus. */
  actionsLabel?: string
  withinTabs?: boolean
  /** More props for the tab list, such as the handlers that drag tabs to reorder them. */
  listProps?: Omit<ComponentProps<typeof TabsList>, "children" | "className" | "aria-label" | "ref" | "activateOnFocus">
  /** More props for a tab, such as an id, a title or more aria-keyshortcuts. */
  tabProps?: (item: TabLineItem) => TabExtras
  /** The tab being dragged, if any (EditorTabGhost draws it under the pointer). */
  drag?: TabLineDrag | null
  "aria-label"?: string
  className?: string
}) {
  const listRef = useRef<HTMLDivElement | null>(null)
  const activeRef = useRef(value)
  // The tab picked from "+N", which gets focus when the menu closes.
  const picked = useRef<string | null>(null)
  // Tabs out of view, the empty width after the last tab in view (which "+N"
  // moves over), and where the active tab ends, for "...".
  const [strip, setStrip] = useState<{ clipped: readonly string[]; gap: number; activeEnd: number | null }>({
    clipped: [],
    gap: 0,
    activeEnd: null,
  })
  const { clipped, gap, activeEnd } = strip
  // The tab whose right-click menu is open, and whether "..." is open.
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [actionsOpen, setActionsOpen] = useState(false)

  const boxes = useCallback((): TabBox[] => {
    const list = listRef.current
    if (!list) return []
    return [...list.querySelectorAll<HTMLElement>("[data-tab-value]")].map((node) => ({
      value: node.dataset.tabValue!,
      left: node.offsetLeft,
      width: node.offsetWidth,
    }))
  }, [])

  const measure = useCallback(() => {
    const list = listRef.current
    if (!list) return
    const all = boxes()
    const next = clippedTabs(all, list.scrollLeft, list.clientWidth)
    const active = all.find((box) => box.value === activeRef.current)
    const end =
      active && active.width > 0 && !next.clipped.includes(active.value)
        ? list.offsetLeft + active.left + active.width - list.scrollLeft
        : null
    setStrip((prev) =>
      prev.gap === next.gap &&
      prev.activeEnd === end &&
      prev.clipped.length === next.clipped.length &&
      prev.clipped.every((tab, i) => tab === next.clipped[i])
        ? prev
        : { ...next, activeEnd: end },
    )
  }, [boxes])

  const reveal = useCallback(
    (tab: string | null) => {
      const list = listRef.current
      if (!list) return
      if (tab !== null) list.scrollLeft = revealStart(boxes(), tab, list.scrollLeft, list.clientWidth)
      measure()
    },
    [boxes, measure],
  )

  const order = items.map((item) => item.value).join("\n")
  useLayoutEffect(() => {
    activeRef.current = value
    reveal(value)
  }, [value, order, reveal])

  // Sizes change with the window, the panels, fonts and the unsaved dots.
  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    let frame = 0
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            cancelAnimationFrame(frame)
            frame = requestAnimationFrame(() => reveal(activeRef.current))
          })
    observer?.observe(list)
    for (const node of list.querySelectorAll("[data-tab-value]")) observer?.observe(node)
    list.addEventListener("scroll", measure, { passive: true })
    return () => {
      cancelAnimationFrame(frame)
      observer?.disconnect()
      list.removeEventListener("scroll", measure)
    }
  }, [order, reveal, measure])

  const hidden = items.filter((item) => clipped.includes(item.value))

  const tab = (item: TabLineItem) => {
    const extras = tabProps?.(item) ?? {}
    const offset = drag?.offsets[item.value] ?? 0
    return (
      <EditorTab
        {...extras}
        key={item.value}
        value={item.value}
        name={item.name}
        badge={item.badge}
        dirty={item.dirty}
        label={item.label}
        onClose={onClose && (() => onClose(item.value))}
        onFocus={(event) => {
          extras.onFocus?.(event)
          reveal(item.value)
        }}
        data-clipped={clipped.includes(item.value) || undefined}
        data-dragging={drag?.value === item.value || undefined}
        style={offset ? { ...extras.style, transform: `translateX(${offset}px)` } : extras.style}
        className={cn(
          "data-clipped:pointer-events-none data-clipped:opacity-0 data-dragging:opacity-0",
          // While "..." shows, the active tab makes room for it at its end,
          // so it never covers the name.
          actions &&
            "data-active:hover:pr-[34px] data-active:focus-visible:pr-[34px] data-active:pointer-coarse:pr-[34px] data-active:group-has-[[data-tab-actions]:is(:hover,:focus-visible,[data-popup-open])]/tabline:pr-[34px]",
          drag?.slide && "transition-transform duration-160 ease-[cubic-bezier(.2,.8,.2,1)] motion-reduce:transition-none",
          extras.className,
        )}
      />
    )
  }

  const line = (
    <div className={cn("group/tabline relative flex min-w-0 flex-1 items-center", className)}>
      <TabsList
        {...listProps}
        ref={listRef}
        aria-label={ariaLabel}
        activateOnFocus
        className="relative flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden"
      >
        {items.map((item) =>
          actions ? (
            <ActionContextMenu
              key={item.value}
              open={menuFor === item.value}
              onOpenChange={(open) => setMenuFor(open ? item.value : null)}
              entries={menuFor === item.value ? actions(item.value) : []}
              aria-label={actionsLabel}
              render={tab(item)}
            />
          ) : (
            tab(item)
          ),
        )}
      </TabsList>
      {actions && value !== null && activeEnd !== null && !drag && (
        <ActionMenu
          open={actionsOpen}
          onOpenChange={setActionsOpen}
          entries={actionsOpen ? actions(value) : []}
          contentProps={{ align: "end", "aria-label": actionsLabel }}
          trigger={
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={actionsLabel}
              data-tab-actions=""
              style={{ left: activeEnd }}
              // Over the active tab's right end, 5 in, on its seg fill; seen
              // with the pointer on the tab or on it, with keyboard focus,
              // while its menu is open, and always on touch screens.
              className="absolute top-1/2 -translate-x-[calc(100%+5px)] -translate-y-1/2 rounded-[6px] bg-seg text-muted-foreground opacity-0 group-has-[[data-tab-value][data-active]:hover]/tabline:opacity-100 group-has-[[data-tab-value][data-active]:focus-visible]/tabline:opacity-100 hover:bg-[color-mix(in_oklab,var(--text)_12%,var(--seg))] hover:text-foreground hover:opacity-100 focus-visible:opacity-100 data-popup-open:bg-[color-mix(in_oklab,var(--text)_12%,var(--seg))] data-popup-open:text-foreground data-popup-open:opacity-100 pointer-coarse:size-8 pointer-coarse:opacity-100"
            >
              <MoreHorizontal />
            </Button>
          }
        />
      )}
      {hidden.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                className="relative px-2.5 font-medium text-dim pointer-coarse:h-10"
                style={{ left: -gap }}
                aria-label={`${hidden.length} more open ${hidden.length === 1 ? "file" : "files"}`}
              />
            }
          >
            +{hidden.length}
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            aria-label="More open files"
            finalFocus={() => {
              // After a pick, focus goes to that tab (which brings it into
              // view), not back to the "+N" button.
              const tab = picked.current
              picked.current = null
              if (tab === null) return true
              return listRef.current?.querySelector<HTMLElement>(`[data-tab-value="${CSS.escape(tab)}"]`) ?? true
            }}
          >
            {hidden.map((item) => (
              <DropdownMenuItem
                key={item.value}
                onClick={() => {
                  picked.current = item.value
                  onValueChange(item.value)
                }}
              >
                {item.badge}
                <span className="min-w-0 truncate">{item.name}</span>
                {item.dirty && <DirtyDot label="Unsaved changes" />}
                {item.detail && (
                  <span className="ml-auto min-w-0 truncate pl-4 font-mono text-[11px] text-dim group-data-highlighted/dropdown-menu-item:text-accent-foreground">
                    {item.detail}
                  </span>
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )

  if (withinTabs) return line
  return (
    <Tabs value={value} onValueChange={(next) => onValueChange(String(next))} className="contents">
      {line}
    </Tabs>
  )
}
