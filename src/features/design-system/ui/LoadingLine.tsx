import { Progress } from "@/components/ui/progress"
import { cn } from "@/lib/utils"
import "./loadingLine.css"

/**
 * A 2px line along the top of a panel while something loads: the shadcn
 * progress bar, indeterminate (a sliding accent segment) unless a value
 * from 0 to 100 is given. Under reduced motion the indeterminate line holds
 * still at half strength instead of sliding.
 */
export function LoadingLine({
  value = null,
  label = "Loading",
  className,
}: {
  value?: number | null
  /** What is loading, for screen readers: "Opening customer-model.mdx". */
  label?: string
  className?: string
}) {
  return (
    <Progress
      value={value}
      aria-label={label}
      className={cn(
        "w-full gap-0 [&_[data-slot=progress-track]]:h-0.5 [&_[data-slot=progress-track]]:rounded-none",
        "[&_[data-slot=progress-indicator][data-indeterminate]]:w-1/3 [&_[data-slot=progress-indicator][data-indeterminate]]:animate-[design-system-loading-line_1.2s_ease-in-out_infinite]",
        "motion-reduce:[&_[data-slot=progress-indicator][data-indeterminate]]:w-full motion-reduce:[&_[data-slot=progress-indicator][data-indeterminate]]:animate-none motion-reduce:[&_[data-slot=progress-indicator][data-indeterminate]]:opacity-50",
        className,
      )}
    />
  )
}
