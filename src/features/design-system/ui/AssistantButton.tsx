import { Sparkles } from "lucide-react"
import type { ComponentProps } from "react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { Hint } from "./Hint"

/**
 * Shows and hides the assistant: in the editor's top line beside the
 * comments button on a desktop (the toolbar icon button, seg while the panel
 * is open), the round button over the file on a phone (`touch`). `busy`
 * adds an accent dot while the assistant is working, also with the panel
 * closed.
 */
export function AssistantButton({
  pressed = false,
  busy = false,
  size = "default",
  className,
  ...props
}: Omit<ComponentProps<typeof Button>, "variant" | "size" | "children" | "aria-label"> & {
  pressed?: boolean
  busy?: boolean
  size?: "default" | "touch"
}) {
  const label = busy ? "Assistant, working" : "Assistant"
  const dot = busy && (
    <span
      data-slot="assistant-busy"
      aria-hidden="true"
      className={cn(
        "absolute rounded-full bg-primary ring-2 ring-panel motion-safe:animate-pulse",
        size === "touch" ? "top-[7px] right-[7px] size-2" : "top-1 right-1 size-[7px]",
      )}
    />
  )
  if (size === "touch")
    return (
      <Button
        variant="outline"
        size="icon-lg"
        aria-label={label}
        aria-pressed={pressed}
        className={cn(
          "relative rounded-full border-panel-border bg-panel text-foreground shadow-[0_6px_18px_var(--shadow)] hover:bg-[color-mix(in_oklab,var(--seg)_50%,var(--panel))] hover:text-foreground active:bg-seg aria-pressed:bg-accent-soft aria-pressed:text-accent-soft-text",
          className,
        )}
        {...props}
      >
        <Sparkles aria-hidden="true" />
        {dot}
      </Button>
    )
  return (
    <Hint label="Assistant">
      <Button
        variant="ghost"
        size="icon"
        aria-label={label}
        aria-pressed={pressed}
        className={cn("relative aria-pressed:bg-seg aria-pressed:text-foreground pointer-coarse:size-10", className)}
        {...props}
      >
        <Sparkles aria-hidden="true" />
        {dot}
      </Button>
    </Hint>
  )
}
