/**
 * Settings, opened from any page. Appearance: the colour palette, and light,
 * dark or the device's setting; and Reading. Those apply at once and are
 * kept on this device. Signed in: Account (your name), and with passkey
 * sign-in on, Passkeys.
 */
import { createContext, useCallback, useContext, useState, type ReactNode } from "react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useAuth } from "@/features/auth/useAuth"
import { Banner, BannerAction, LoadingLine } from "@/features/design-system"
import { moduleLoader, useModule } from "@/lib/moduleLoader"

// The sections, with their controls, load the first time Settings opens, so
// they stay out of every page's first paint.
const sections = moduleLoader(() => import("./SettingsSections"))

const SettingsContext = createContext<(() => void) | null>(null)

/** Opens Settings. */
export function useOpenSettings(): () => void {
  const open = useContext(SettingsContext)
  if (!open) throw new Error("useOpenSettings must be used within SettingsProvider")
  return open
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  // Set once the account is deleted, which signs out: Settings says so until it closes.
  const [deleted, setDeleted] = useState(false)
  const openSettings = useCallback(() => {
    setDeleted(false)
    setOpen(true)
  }, [])
  return (
    <SettingsContext.Provider value={openSettings}>
      {children}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Settings</DialogTitle>
            <SettingsDescription />
          </DialogHeader>
          {deleted ? <Banner tone="info">Your account was deleted, and you are signed out.</Banner> : null}
          <Sections onDeleted={() => setDeleted(true)} />
        </DialogContent>
      </Dialog>
    </SettingsContext.Provider>
  )
}

/** Where each setting is kept: appearance and reading on this device; signed in, Account and Passkeys with the account. */
function SettingsDescription() {
  const signedIn = useAuth().status === "ready"
  return (
    <DialogDescription>
      Appearance and reading are kept on this device.{signedIn ? " Your name and passkeys are kept with your account." : ""}
    </DialogDescription>
  )
}

/** The sections once their chunk has loaded: a loading line until then, and Try again when it fails. */
function Sections({ onDeleted }: { onDeleted: () => void }) {
  const { module, error, retry } = useModule(sections, true)
  if (module) {
    const { SettingsSections } = module
    return <SettingsSections onDeleted={onDeleted} />
  }
  if (error)
    return (
      <Banner tone="danger" action={<BannerAction onClick={retry}>Try again</BannerAction>}>
        Settings could not load.
      </Banner>
    )
  return <LoadingLine label="Loading settings" />
}
