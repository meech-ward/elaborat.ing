import { Bot } from "lucide-react"
import type { ComponentProps } from "react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { Hint } from "./Hint"

// The project's Agent changes button and its count, on their own: they are in
// the project page's first paint, and the change row (AgentChangeRow.tsx) is not.

type Size = "default" | "touch"

/**
 * A small count over a button: 18 high, the accent with a panel ring, 11px
 * mono 600, "99+" past 99. Decoration only: the button's name says the count.
 */
export function CountBadge({ count, className }: { count: number; className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-slot="count-badge"
      className={cn(
        "flex h-[18px] min-w-[18px] items-center justify-center rounded-pill bg-primary px-1 font-mono text-[11px] font-semibold text-primary-foreground tabular-nums ring-2 ring-panel",
        className,
      )}
    >
      {count > 99 ? "99+" : count}
    </span>
  )
}

/**
 * Opens the project's Agent changes: the bot icon as a ghost icon button (30,
 * 40 on phones, as the share button beside it), with the count of changes
 * new to the person at its top right. Its name says the count: "Agent
 * changes, 3 new".
 */
export function AgentChangesButton({
  count,
  size = "default",
  className,
  ...props
}: Omit<ComponentProps<typeof Button>, "variant" | "size" | "children" | "aria-label"> & { count: number; size?: Size }) {
  const label = count > 0 ? `Agent changes, ${count > 99 ? "over 99" : count} new` : "Agent changes"
  const button = (
    <Button
      variant="ghost"
      size={size === "touch" ? "icon-lg" : "icon"}
      aria-label={label}
      data-agent-changes=""
      className={cn("relative", size === "touch" && "rounded-tile", className)}
      {...props}
    >
      <Bot aria-hidden="true" />
      {count > 0 && <CountBadge count={count} className="absolute -top-1 -right-1" />}
    </Button>
  )
  // Phones have no pointer to hover with.
  return size === "touch" ? button : <Hint label="Agent changes">{button}</Hint>
}
