import { useId } from "react"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useAppearance, type ColorMode, type ThemeName } from "@/features/appearance"
import { palettes } from "@/features/appearance/palettes"

// The page's palette and Light, Dark or System: the app's own appearance
// setting (the same one Settings changes), so the choice sticks.
const MODES: readonly { id: ColorMode; label: string }[] = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "system", label: "System" },
]

const PALETTE_ITEMS = palettes.map(({ id, label }) => ({ value: id, label }))

export function AppearancePicker() {
  const { appearance, mode, setMode, setTheme } = useAppearance()
  const paletteId = useId()
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Label htmlFor={paletteId} className="text-[13px] text-muted-foreground">
        Palette
      </Label>
      <Select
        items={PALETTE_ITEMS}
        value={appearance.theme}
        onValueChange={(value) => {
          if (value) setTheme(value as ThemeName)
        }}
      >
        <SelectTrigger id={paletteId} className="min-w-44">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
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
      >
        {MODES.map(({ id, label }) => (
          <ToggleGroupItem key={id} value={id} size="sm" className="pointer-coarse:h-10">
            {label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  )
}
