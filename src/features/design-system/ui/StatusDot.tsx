import type { ComponentProps } from "react"
import { cn } from "@/lib/utils"

// Save and sync status. No shadcn primitive is a status dot: these are spans
// with the words next to the dot, so colour is never the only signal.

export type SaveStatus = "synced" | "unsaved" | "failed" | "offline"

const LABEL: Record<SaveStatus, string> = {
  synced: "Synced",
  unsaved: "Unsaved",
  failed: "Not saved",
  offline: "Offline",
}

// Synced: an ok dot; unsaved: the dirty dot; offline: a hollow ring; not
// saved: the words alone, in the danger colour.
const DOT: Record<SaveStatus, string | null> = {
  synced: "bg-ok",
  unsaved: "bg-dirty",
  offline: "border-[1.5px] border-dim",
  failed: null,
}

/** A status with its dot: Synced, Unsaved, Not saved, Offline. The text takes the parent's colour. */
export function StatusDot({
  status,
  children,
  className,
  ...props
}: ComponentProps<"span"> & { status: SaveStatus }) {
  const dot = DOT[status]
  return (
    <span
      data-status={status}
      className={cn("inline-flex items-center gap-1.5 whitespace-nowrap", status === "failed" && "text-destructive", className)}
      {...props}
    >
      {dot && <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", dot)} />}
      {children ?? LABEL[status]}
    </span>
  )
}

/**
 * The 7px dot on a tab or tree row whose file has unsaved edits. With a
 * label, screen readers hear it; without one, it is decoration next to words
 * that already say so.
 */
export function DirtyDot({ label, className, ...props }: ComponentProps<"span"> & { label?: string }) {
  return (
    <span
      data-slot="dirty-dot"
      aria-hidden={label ? undefined : true}
      className={cn("inline-block size-[7px] shrink-0 rounded-full bg-dirty", className)}
      {...props}
    >
      {label && <span className="sr-only">{label}</span>}
    </span>
  )
}
