import { Diamond } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * The pages outside a project (the home, sign-in and Connected agents) sit on
 * the dotted background the project page uses.
 */
export function DottedPage({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "min-h-svh bg-(--chrome) bg-[radial-gradient(var(--dot)_1px,transparent_1.4px)] bg-size-[22px_22px]",
        className,
      )}
      {...props}
    />
  )
}

/** A floating panel: the palette's panel colour, a 1px border, radius 14 and the panel shadow. */
export const panel = "rounded-[14px] border border-border bg-background shadow-[0_10px_30px_var(--shadow)]"

/** The diamond mark and the name. */
export function Brand({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 font-bold tracking-tight", className)}>
      <Diamond aria-hidden="true" className="size-[0.8em] shrink-0 text-primary" strokeWidth={2.4} />
      elaborat.ing
    </span>
  )
}
