import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

// No shadcn primitive fits: this only places the phone's round buttons.

/**
 * The phone's header over the open file: `back` (a RoundIconButton) at the
 * top left and the file's controls at the top right, 14 from the edges and 8
 * apart, floating over the file. Only the controls take the pointer; the file
 * shows and scrolls between them. Put it in a positioned parent, or pass
 * `relative` to keep it in the flow.
 */
export function PhoneHeader({ back, children, className }: { back?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div
      data-slot="phone-header"
      className={cn("pointer-events-none absolute inset-x-0 top-0 z-30 flex items-center gap-2 p-3.5 *:pointer-events-auto", className)}
    >
      {back}
      <div className="ml-auto flex items-center gap-2 pointer-events-none! *:pointer-events-auto">{children}</div>
    </div>
  )
}
