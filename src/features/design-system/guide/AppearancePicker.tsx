import { useId } from "react"
import { Label } from "@/components/ui/label"
import { ColorModeToggle, PaletteSelect } from "../ui/AppearanceControls"
import { useGuidePortal } from "./parts"

// The page's palette and Light, Dark or System: the app's own appearance
// setting (the same one Settings changes), so the choice sticks.
export function AppearancePicker() {
  const paletteId = useId()
  const portal = useGuidePortal()
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Label htmlFor={paletteId} className="text-[13px] text-muted-foreground">
        Palette
      </Label>
      <PaletteSelect id={paletteId} container={portal} />
      <ColorModeToggle />
    </div>
  )
}
