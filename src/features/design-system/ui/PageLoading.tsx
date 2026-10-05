import { DottedPage } from "@/components/panel"
import { cn } from "@/lib/utils"
import { SharpDiamond } from "./SharpDiamond"

/**
 * A page while its code downloads, as index.html's shell draws the app
 * starting: the dotted page with the app's mark pulsing in the middle (the
 * shell's app-shell-pulse, held still under reduced motion). It fills the
 * window; `className` sizes it otherwise, such as under a chat panel's bar.
 */
export function PageLoading({ className }: { className?: string }) {
  return (
    <DottedPage role="status" aria-label="Loading the page" className={cn("grid place-items-center text-primary", className)}>
      <SharpDiamond
        aria-hidden="true"
        strokeLinejoin="miter"
        className="size-7 animate-[app-shell-pulse_1.2s_ease-in-out_infinite_alternate] motion-reduce:animate-none"
      />
    </DottedPage>
  )
}
