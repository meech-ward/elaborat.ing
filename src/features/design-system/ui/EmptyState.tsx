import type { ReactNode } from "react"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"

/**
 * What a panel shows when it has nothing yet: an icon tile, a short title, a
 * sentence on what to do, and the buttons that do it. The shadcn empty.
 */
export function EmptyState({
  icon,
  title,
  description,
  actions,
  titleLevel,
  className,
}: {
  icon?: ReactNode
  title: string
  /** Makes the title a heading at this level, where it heads a view of its own. */
  titleLevel?: 2 | 3 | 4
  description?: ReactNode
  /** Buttons, the main one last. */
  actions?: ReactNode
  className?: string
}) {
  return (
    <Empty className={className}>
      <EmptyHeader>
        {icon && <EmptyMedia variant="icon">{icon}</EmptyMedia>}
        <EmptyTitle role={titleLevel ? "heading" : undefined} aria-level={titleLevel}>
          {title}
        </EmptyTitle>
        {description && <EmptyDescription>{description}</EmptyDescription>}
      </EmptyHeader>
      {actions && <EmptyContent className="flex-row flex-wrap justify-center gap-2">{actions}</EmptyContent>}
    </Empty>
  )
}
