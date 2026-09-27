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
  className,
}: {
  icon?: ReactNode
  title: string
  description?: ReactNode
  /** Buttons, the main one last. */
  actions?: ReactNode
  className?: string
}) {
  return (
    <Empty className={className}>
      <EmptyHeader>
        {icon && <EmptyMedia variant="icon">{icon}</EmptyMedia>}
        <EmptyTitle>{title}</EmptyTitle>
        {description && <EmptyDescription>{description}</EmptyDescription>}
      </EmptyHeader>
      {actions && <EmptyContent className="flex-row flex-wrap justify-center gap-2">{actions}</EmptyContent>}
    </Empty>
  )
}
