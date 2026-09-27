import { Code, Columns2, Eye, type LucideIcon } from "lucide-react"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { cn } from "@/lib/utils"
import { Hint } from "./Hint"
import { isApplePlatform, viewShortcut } from "./shortcuts"
import { EDITOR_VIEWS, mandatoryView, viewLabel, type EditorView, type ViewNames } from "./views"

export type { EditorView, ViewNames } from "./views"

const ICONS: Record<EditorView, LucideIcon> = { source: Code, split: Columns2, rendered: Eye }

/**
 * Source, Split and Rendered as a segmented switch: the shadcn toggle group
 * in its segment look (a seg track with 32 by 28 icon buttons; the view that
 * is on sits on the panel colour with a panel-border ring). Base UI gives it
 * arrow-key movement between the views. Each view has its name as the
 * accessible name, its shortcut (⌘⌥1 to 3, Ctrl+Alt+1 to 3) as
 * aria-keyshortcuts, and both in a tooltip. One view is always on. On touch
 * screens the buttons grow to 40 high.
 *
 * `views` limits the switch, for example to Source and Rendered on phones,
 * where there is no room to split. `names="canvas"` calls the views Code,
 * Split and Canvas, for a drawing or a diagram.
 */
export function ViewSwitch({
  value,
  onValueChange,
  views = ["source", "split", "rendered"],
  names = "note",
  disabled,
  "aria-label": ariaLabel = "View",
  className,
}: {
  value: EditorView
  onValueChange: (view: EditorView) => void
  views?: readonly EditorView[]
  names?: ViewNames
  disabled?: boolean
  "aria-label"?: string
  className?: string
}) {
  const apple = isApplePlatform()
  return (
    <ToggleGroup
      aria-label={ariaLabel}
      variant="segment"
      size="icon"
      spacing={0.5}
      value={[value]}
      disabled={disabled}
      onValueChange={(next) => {
        const view = mandatoryView(value, next, views)
        if (view !== value) onValueChange(view)
      }}
      className={cn("shrink-0", className)}
    >
      {EDITOR_VIEWS.filter((view) => views.includes(view.value)).map((view) => {
        const Icon = ICONS[view.value]
        const shortcut = viewShortcut(view.digit, apple)
        const label = viewLabel(view.value, names)
        return (
          <Hint key={view.value} label={label} shortcut={shortcut.label}>
            <ToggleGroupItem
              value={view.value}
              aria-label={label}
              aria-keyshortcuts={shortcut.aria}
              className="pointer-coarse:h-10 pointer-coarse:w-11"
            >
              <Icon />
            </ToggleGroupItem>
          </Hint>
        )
      })}
    </ToggleGroup>
  )
}
