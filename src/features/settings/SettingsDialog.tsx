/**
 * Settings, opened from any page. Appearance: the colour palette, and light,
 * dark or the device's setting. Choices apply at once and are kept on this
 * device.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { themes, useAppearance, type ColorMode } from "@/features/appearance"
import { palettes } from "@/features/appearance/palettes"
import { cn } from "@/lib/utils"

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
            <DialogDescription>Kept on this device.</DialogDescription>
          </DialogHeader>
          <AppearanceSection />
        </DialogContent>
      </Dialog>
    </SettingsContext.Provider>
  )
}

const MODES: Array<{ id: ColorMode; label: string }> = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "system", label: "System" },
]

function AppearanceSection() {
  const { appearance, mode, setMode, setTheme } = useAppearance()
  const swatches = useMemo(() => palettes.map((palette) => ({ ...palette, colors: palette[appearance.scheme] })), [appearance.scheme])
  return (
    <section aria-labelledby="settings-appearance" className="grid gap-4">
      <h3 id="settings-appearance" className="text-sm font-semibold">
        Appearance
      </h3>
      <fieldset className="grid gap-2">
        <legend className="mb-2 text-xs font-semibold text-muted-foreground">Palette</legend>
        <div className="grid grid-cols-2 gap-2">
          {swatches.map(({ id, colors }) => (
            <label key={id} className="relative cursor-pointer">
              <input
                type="radio"
                name="settings-palette"
                value={id}
                checked={appearance.theme === id}
                onChange={() => setTheme(id)}
                className="peer absolute inset-0 cursor-pointer opacity-0"
              />
              <span
                className={cn(
                  "flex items-center gap-2 rounded-lg border border-border p-2 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring",
                  appearance.theme === id && "border-transparent ring-2 ring-ring",
                )}
              >
                <span aria-hidden className="flex overflow-hidden rounded-md border border-border">
                  {[colors.bg, colors.panel, colors.accent, colors.text].map((color, index) => (
                    <span key={index} className="size-5" style={{ background: color }} />
                  ))}
                </span>
                <span className="text-sm">{themes.find((theme) => theme.id === id)?.label}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="grid gap-2">
        <legend className="mb-2 text-xs font-semibold text-muted-foreground">Mode</legend>
        <div className="flex gap-2">
          {MODES.map(({ id, label }) => (
            <label key={id} className="relative cursor-pointer">
              <input
                type="radio"
                name="settings-mode"
                value={id}
                checked={mode === id}
                onChange={() => setMode(id)}
                className="peer absolute inset-0 cursor-pointer opacity-0"
              />
              <span
                className={cn(
                  "inline-flex h-8 items-center rounded-lg border border-border px-3 text-sm peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring",
                  mode === id && "border-transparent bg-primary text-primary-foreground",
                )}
              >
                {label}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
    </section>
  )
}
