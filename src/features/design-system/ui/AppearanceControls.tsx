import type { ComponentProps } from "react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { palettes, useAppearance, type ColorMode, type ThemeName } from "@/features/appearance"
import { cn } from "@/lib/utils"

// The appearance setting's two controls: which palette, and Light, Dark or
// System. They change the app's own appearance (the choice sticks), as
// Settings and the style guide's header use them.

const MODES: readonly { id: ColorMode; label: string }[] = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "system", label: "System" },
]

const PALETTE_ITEMS = palettes.map(({ id, label }) => ({ value: id, label }))

/**
 * The palette as a shadcn select: each palette by name, with a dot in its
 * accent for the current light or dark. Label it with a <Label htmlFor={id}>.
 */
export function PaletteSelect({
  id,
  container,
  className,
}: {
  id?: string
  /** Where the list renders (the body by default). */
  container?: ComponentProps<typeof SelectContent>["container"]
  className?: string
}) {
  const { appearance, setTheme } = useAppearance()
  return (
    <Select
      items={PALETTE_ITEMS}
      value={appearance.theme}
      onValueChange={(value) => {
        if (value) setTheme(value as ThemeName)
      }}
    >
      <SelectTrigger id={id} className={cn("min-w-44", className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent container={container}>
        {palettes.map((palette) => (
          <SelectItem key={palette.id} value={palette.id}>
            <span
              aria-hidden="true"
              className="size-3 shrink-0 rounded-pill border border-panel-border"
              style={{ background: palette[appearance.scheme].accent }}
            />
            {palette.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** Light, Dark or System as the segmented toggle (the view switch's look); one is always chosen. */
export function ColorModeToggle({ className }: { className?: string }) {
  const { mode, setMode } = useAppearance()
  return (
    <ToggleGroup
      aria-label="Mode"
      variant="segment"
      spacing={0.5}
      value={[mode]}
      onValueChange={(value) => {
        // One mode is always chosen: pressing the current one keeps it.
        const next = value[0] as ColorMode | undefined
        if (next) setMode(next)
      }}
      className={className}
    >
      {MODES.map(({ id, label }) => (
        <ToggleGroupItem key={id} value={id} size="sm" className="pointer-coarse:h-10">
          {label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
