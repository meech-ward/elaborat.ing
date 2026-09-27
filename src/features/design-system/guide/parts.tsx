import { useId, type ReactNode } from "react"
import { Card } from "@/components/ui/card"
import { cn } from "@/lib/utils"

// The style guide's own layout pieces, shared by every section of the page.

/** A card on the page with the small uppercase heading: "Colour tokens", "Type" ... */
export function GuideCard({ title, className, children }: { title: string; className?: string; children?: ReactNode }) {
  const id = useId()
  return (
    <Card role="region" aria-labelledby={id} className={cn("px-[22px]", className)}>
      <h2 id={id} className="text-[13px] font-semibold tracking-[0.07em] text-dim uppercase">
        {title}
      </h2>
      {children}
    </Card>
  )
}

/**
 * One section inside a card, with its heading: a component group such as
 * Controls. The section renders its own demos as children.
 */
export function GuideGroup({ title, className, children }: { title: string; className?: string; children?: ReactNode }) {
  const id = useId()
  return (
    <section aria-labelledby={id} className={cn("flex min-w-0 flex-col gap-3", className)}>
      <h3 id={id} className="text-[13px] font-semibold text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  )
}

/** The small monospace caption over a demo: "Buttons", "Menu" ... */
export function GuideLabel({ className, children }: { className?: string; children: ReactNode }) {
  return <span className={cn("font-mono text-xs text-muted-foreground", className)}>{children}</span>
}

/** A value or spec in the smaller monospace caption: "#F6F8F7", "H1 · 32 / 700". */
export function GuideValue({ className, children }: { className?: string; children: ReactNode }) {
  return <span className={cn("font-mono text-[11px] text-dim", className)}>{children}</span>
}
