/**
 * Settings, opened from any page. Appearance: the colour palette, and light,
 * dark or the device's setting; and Reading. Those apply at once and are
 * kept on this device. Signed in: Account (your name), and with passkey
 * sign-in on, Passkeys.
 */
import { createContext, useCallback, useContext, useId, useState, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { useAppearance } from "@/features/appearance"
import { readingPreferencesSchema } from "@/features/appearance/reading"
import { ColorModeToggle, PaletteSelect } from "@/features/design-system"
import { AccountSection } from "./AccountSection"
import { PasskeysSection } from "./PasskeysSection"

const SettingsContext = createContext<(() => void) | null>(null)

/** Opens Settings. */
export function useOpenSettings(): () => void {
  const open = useContext(SettingsContext)
  if (!open) throw new Error("useOpenSettings must be used within SettingsProvider")
  return open
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const openSettings = useCallback(() => setOpen(true), [])
  return (
    <SettingsContext.Provider value={openSettings}>
      {children}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Settings</DialogTitle>
            <DialogDescription>Appearance and reading are kept on this device.</DialogDescription>
          </DialogHeader>
          <AppearanceSection />
          <ReadingSection />
          <AccountSection />
          <PasskeysSection />
        </DialogContent>
      </Dialog>
    </SettingsContext.Provider>
  )
}

/** A setting: its label at the start, its control at the end (stacked on a narrow screen). */
function SettingRow({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <Label htmlFor={htmlFor} className="text-[13px] font-normal text-foreground">
        {label}
      </Label>
      {children}
    </div>
  )
}

/** The palette and Light, Dark or System: the library's appearance controls. */
function AppearanceSection() {
  const paletteId = useId()
  return (
    <section aria-labelledby="settings-appearance" className="grid gap-3">
      <h3 id="settings-appearance" className="text-sm font-semibold">
        Appearance
      </h3>
      <SettingRow label="Palette" htmlFor={paletteId}>
        <PaletteSelect id={paletteId} />
      </SettingRow>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <span className="text-[13px]">Mode</span>
        <ColorModeToggle />
      </div>
    </section>
  )
}

const WIDTHS = [
  { value: "standard", label: "Standard (680px)" },
  { value: "wide", label: "Wide (1040px)" },
  { value: "full", label: "Full width" },
]
const TEXT_SIZES = [
  { value: "default", label: "Default" },
  { value: "large", label: "Large" },
  { value: "larger", label: "Larger" },
]

/** How rendered notes read in this browser; files are unchanged. */
function ReadingSection() {
  const { reading, setReading, resetReading } = useAppearance()
  const widthId = useId()
  const sizeId = useId()
  const mediaId = useId()
  const tablesId = useId()
  return (
    <section aria-labelledby="settings-reading" className="grid gap-3">
      <h3 id="settings-reading" className="text-sm font-semibold">
        Reading
      </h3>
      <SettingRow label="Document width" htmlFor={widthId}>
        <Select
          items={WIDTHS}
          value={reading.width}
          onValueChange={(value) => {
            if (value) setReading(readingPreferencesSchema.parse({ ...reading, width: value }))
          }}
        >
          <SelectTrigger id={widthId} className="min-w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {WIDTHS.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>
      <SettingRow label="Text size" htmlFor={sizeId}>
        <Select
          items={TEXT_SIZES}
          value={reading.textSize}
          onValueChange={(value) => {
            if (value) setReading(readingPreferencesSchema.parse({ ...reading, textSize: value }))
          }}
        >
          <SelectTrigger id={sizeId} className="min-w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TEXT_SIZES.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>
      <SettingRow label="Wide media" htmlFor={mediaId}>
        <Switch id={mediaId} checked={reading.wideMedia} onCheckedChange={(checked) => setReading({ ...reading, wideMedia: checked })} />
      </SettingRow>
      <SettingRow label="Wide tables" htmlFor={tablesId}>
        <Switch id={tablesId} checked={reading.wideTables} onCheckedChange={(checked) => setReading({ ...reading, wideTables: checked })} />
      </SettingRow>
      <p className="text-xs text-muted-foreground">Wide media and tables can extend beyond the text column, never beyond the window.</p>
      <div>
        <Button variant="outline" size="sm" onClick={resetReading}>
          Reset reading defaults
        </Button>
      </div>
    </section>
  )
}
