import { useRef } from "react"
import { useRegisterSW } from "virtual:pwa-register/react"
import { Button } from "@/components/ui/button"

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
    // The info banner look: a panel with the menu shadow around a strip in
    // the selection colour with link text.
    <div
      role="status"
      className="fixed right-4 bottom-12 z-40 rounded-[12px] border border-[var(--panel-border)] bg-[var(--panel)] p-1.5 shadow-[0_16px_40px_var(--shadow)]"
    >
      <Button
        variant="ghost"
        className="h-auto rounded-[10px] bg-[var(--accent-soft)] px-3 py-2.5 text-[var(--accent-soft-text)] hover:bg-[var(--accent-soft)] hover:text-[var(--accent-soft-text)] hover:underline active:bg-[var(--accent-soft)]"
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
    </div>
  )
}
