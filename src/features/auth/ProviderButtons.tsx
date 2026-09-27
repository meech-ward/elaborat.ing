import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Banner } from "@/features/design-system"
import { parseConfig } from "@/lib/config"
import { createClient } from "@/lib/supabase/client"
import { enabledProviders, PROVIDERS, type ProviderId } from "./providers"
import { emailLinkRedirect } from "./returnPath"

/**
 * "Continue with GitHub" and "Continue with Google", under an "or", for the
 * providers Auth has on. The provider sends the person back to the sign-in
 * page with `next`, as the emailed link does. Offline, or when Auth's settings
 * cannot be read, nothing shows.
 */
export function ProviderButtons({ next }: { next: string | null }) {
  const [providers, setProviders] = useState<ProviderId[]>([])
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    enabledProviders(parseConfig(import.meta.env)).then(
      (enabled) => {
        if (alive) setProviders(enabled)
      },
      () => {},
    )
    return () => {
      alive = false
    }
  }, [])

  if (providers.length === 0) return null
  const continueWith = async (provider: ProviderId) => {
    setError(null)
    const { error } = await createClient().auth.signInWithOAuth({
      provider,
      options: { redirectTo: emailLinkRedirect(window.location.origin, next) },
    })
    if (error) setError(error.message)
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3 text-xs text-dim">
        <Separator className="h-px flex-1" />
        or
        <Separator className="h-px flex-1" />
      </div>
      {PROVIDERS.filter((provider) => providers.includes(provider.id)).map((provider) => (
        <Button key={provider.id} type="button" variant="outline" size="lg" className="w-full" onClick={() => void continueWith(provider.id)}>
          {provider.label}
        </Button>
      ))}
      {error ? <Banner tone="danger">{error}</Banner> : null}
    </div>
  )
}
