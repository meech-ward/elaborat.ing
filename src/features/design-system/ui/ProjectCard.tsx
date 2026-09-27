import { useRender } from "@base-ui/react/use-render"
import { Plus } from "lucide-react"
import type { ComponentProps, FormEvent, ReactElement, ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"
import { initialFor } from "./AccountRows"
import { FloatingPanel } from "./FloatingPanel"

// The home page's projects. No shadcn primitive fits the grid or a card
// that is a list item with a link and a menu in it: Card renders only a div,
// so the cards are FloatingPanels rendered as list items, and the form in
// the new project card is shadcn's Label, Input and Button.

/** The cards in a grid: as many 240 wide columns as fit, 12 apart (16 from 640 up); one column on phones. */
export function ProjectGrid({ className, ...props }: ComponentProps<"ul">) {
  return (
    <ul
      data-slot="project-grid"
      className={cn("grid grid-cols-[repeat(auto-fill,minmax(min(100%,240px),1fr))] gap-3 sm:gap-4", className)}
      {...props}
    />
  )
}

/**
 * One project: a floating panel 128 high, padding 16. The initial in an
 * accentSoft tile at the top left, `actions` (an ActionMenu's button) at the
 * top right, then the title at 600 15px, which is `link` (such as
 * <Link to=... />): the link covers the whole card, so the card opens on a
 * click anywhere but the actions, and its focus ring rings the card. `meta`
 * goes under the title in 12px dim (the sync state). On phones (under 640)
 * the card is a row: tile, title and actions.
 */
export function ProjectCard({
  title,
  link,
  meta,
  actions,
  className,
}: {
  title: string
  link: ReactElement
  meta?: ReactNode
  actions?: ReactNode
  className?: string
}) {
  const titleLink = useRender({
    render: link,
    props: {
      "data-slot": "project-card-link",
      className:
        "outline-none [overflow-wrap:anywhere] after:absolute after:inset-0 after:rounded-panel after:content-['']",
      children: title,
    },
  })
  return (
    <FloatingPanel
      render={<li />}
      data-slot="project-card"
      className={cn(
        "relative grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 p-4 transition-colors hover:bg-[color-mix(in_oklab,var(--seg)_45%,var(--panel))] has-[[data-slot=project-card-link]:focus-visible]:outline-2 has-[[data-slot=project-card-link]:focus-visible]:outline-offset-2 has-[[data-slot=project-card-link]:focus-visible]:outline-ring has-[[data-slot=project-card-link]:focus-visible]:outline-solid motion-reduce:transition-none sm:min-h-32 sm:grid-cols-[auto_minmax(0,1fr)] sm:grid-rows-[auto_1fr] sm:items-start",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="flex size-8 shrink-0 items-center justify-center rounded-tool bg-accent-soft text-[13px] font-semibold text-accent-soft-text"
      >
        {initialFor(title)}
      </span>
      <div className="flex min-w-0 flex-col gap-1 sm:col-span-2 sm:row-start-2 sm:self-end">
        <p className="text-[15px] leading-snug font-semibold text-foreground">{titleLink}</p>
        {meta && <div className="text-xs leading-normal text-dim *:whitespace-normal">{meta}</div>}
      </div>
      {/* Above the link's cover, so the menu opens instead of the project. */}
      {actions && <div className="relative z-10 -mr-1 sm:col-start-2 sm:row-start-1 sm:-mt-1 sm:justify-self-end">{actions}</div>}
    </FloatingPanel>
  )
}

/**
 * The card that starts a project: the same size, flat, its border dashed a
 * shade darker, with a title field (labelled `label`) and the primary
 * Create button beside it, the field as high as the button (40 on touch
 * screens).
 */
export function NewProjectCard({
  id,
  value,
  onValueChange,
  onSubmit,
  label = "New project",
  placeholder = "Project title",
  submitLabel = "Create",
  disabled,
  className,
}: {
  /** The field's id, for its label. */
  id: string
  value: string
  onValueChange: (value: string) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  label?: string
  placeholder?: string
  submitLabel?: string
  disabled?: boolean
  className?: string
}) {
  return (
    <FloatingPanel
      render={<li />}
      variant="flat"
      data-slot="new-project-card"
      className={cn("flex flex-col border-dashed border-[color-mix(in_oklab,var(--panel-border)_55%,var(--faint))] p-4 sm:min-h-32", className)}
    >
      <form onSubmit={onSubmit} className="flex flex-1 flex-col justify-between gap-3">
        <Label htmlFor={id} className="gap-1.5 text-[13px] font-semibold">
          <Plus aria-hidden="true" className="size-4 text-primary" strokeWidth={2.4} />
          {label}
        </Label>
        <div className="flex gap-2">
          <Input
            id={id}
            value={value}
            onChange={(event) => onValueChange(event.target.value)}
            placeholder={placeholder}
            disabled={disabled}
            className="pointer-coarse:h-10"
          />
          <Button type="submit" disabled={disabled}>
            {submitLabel}
          </Button>
        </div>
      </form>
    </FloatingPanel>
  )
}
