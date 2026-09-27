import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Tabs, TabsList } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
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

/**
 * The open files as a line of EditorTabs, 2 apart, on the shadcn tabs. Tabs
 * that don't fit stay in the tab list (and the accessibility tree) but out
 * of view, and "+N" right after the last tab in view lists them in a menu;
 * picking one opens it and brings it into view. The active tab is always in
 * view, and so is a tab reached with the arrow keys.
 *
 * TabLine is only the tab list: tab panels, if any, belong to the caller.
 */
export function TabLine({
  items,
  value,
  onValueChange,
  onClose,
  "aria-label": ariaLabel = "Open files",
  className,
}: {
  items: readonly TabLineItem[]
  /** The active tab's value, or null when no file is open. */
  value: string | null
  onValueChange: (value: string) => void
  onClose?: (value: string) => void
  "aria-label"?: string
  className?: string
}) {
  const listRef = useRef<HTMLDivElement | null>(null)
  const activeRef = useRef(value)
  // The tab picked from "+N", which gets focus when the menu closes.
  const picked = useRef<string | null>(null)
  const [strip, setStrip] = useState<{ clipped: readonly string[]; gap: number }>({ clipped: [], gap: 0 })
  const { clipped, gap } = strip

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
    const next = clippedTabs(boxes(), list.scrollLeft, list.clientWidth)
    setStrip((prev) =>
      prev.gap === next.gap && prev.clipped.length === next.clipped.length && prev.clipped.every((tab, i) => tab === next.clipped[i])
        ? prev
        : next,
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

  return (
    <Tabs value={value} onValueChange={(next) => onValueChange(String(next))} className="contents">
      <div className={cn("flex min-w-0 flex-1 items-center", className)}>
        <TabsList ref={listRef} aria-label={ariaLabel} activateOnFocus className="relative flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden">
          {items.map((item) => (
            <EditorTab
              key={item.value}
              value={item.value}
              name={item.name}
              badge={item.badge}
              dirty={item.dirty}
              label={item.label}
              onClose={onClose && (() => onClose(item.value))}
              onFocus={() => reveal(item.value)}
              data-clipped={clipped.includes(item.value) || undefined}
              className="data-clipped:pointer-events-none data-clipped:opacity-0"
            />
          ))}
        </TabsList>
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
    </Tabs>
  )
}
