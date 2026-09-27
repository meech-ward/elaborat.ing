import { useRef } from "react"
import { useRegisterSW } from "virtual:pwa-register/react"
import { Button } from "@/components/ui/button"
import { FloatingPanel } from "@/features/design-system"

/**
 * Registers the service worker and, once a new version of the app has
 * installed, shows "Update ready". The new version waits until the person
 * chooses it, and then this tab reloads into it. The app never reloads by
 * itself: when the update is chosen in another tab, this one keeps running
 * until the person chooses it here too.
 */
export function UpdateReady() {
  const chosen = useRef(false)
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    // The new version has taken over this tab.
    onNeedReload() {
      if (chosen.current) window.location.reload()
    },
  })
  if (!needRefresh) return null
  return (
    // A small floating panel at the bottom right holding the button in the
    // callout's colours (accentSoft), as the library draws news to act on.
    <FloatingPanel render={<div role="status" />} className="fixed right-4 bottom-12 z-40 p-1.5">
      <Button
        variant="ghost"
        className="h-auto rounded-tile bg-accent-soft px-3 py-2.5 text-accent-soft-text hover:bg-accent-soft hover:text-accent-soft-text hover:underline active:bg-accent-soft"
        onClick={() => {
          chosen.current = true
          void navigator.serviceWorker.getRegistration().then((registration) => {
            if (registration?.waiting) void updateServiceWorker()
            // Chosen in another tab already, so the new version is running.
            else window.location.reload()
          })
        }}
      >
        Update ready
      </Button>
    </FloatingPanel>
  )
}
