import { createContext, useContext, useId, type ReactNode, type RefObject } from "react"
import { Card } from "@/components/ui/card"
import { cn } from "@/lib/utils"

// The style guide's own layout pieces, shared by every section of the page.

/**
 * Where the page's live popups (menus, the palette list) render: an element
 * inside the page's main landmark, so an open popup sits in the page's
 * landmarks like the rest of it (in the body it would sit outside them).
 * Pass it as the popup's portal container.
 */
export const GuidePortal = createContext<RefObject<HTMLDivElement | null> | undefined>(undefined)
export const useGuidePortal = () => useContext(GuidePortal)

/** A card on the page with the small uppercase heading: "Colour tokens", "Type" ... */
export function GuideCard({ title, className, children }: { title: string; className?: string; children?: ReactNode }) {
  const id = useId()
  return (
    <Card role="region" aria-labelledby={id} className={cn("px-[22px]", className)}>
      <h2 id={id} className="text-[13px] leading-[normal] font-semibold tracking-[0.07em] text-dim uppercase">
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
  return <span className={cn("font-mono text-xs leading-[normal] text-muted-foreground", className)}>{children}</span>
}

/** A value or spec in the smaller monospace caption: "#F6F8F7", "H1 · 32 / 700". */
export function GuideValue({ className, children }: { className?: string; children: ReactNode }) {
  return <span className={cn("font-mono text-[11px] leading-[normal] text-dim", className)}>{children}</span>
}
