import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { parseConfig } from "@/lib/config"
import { createClient } from "@/lib/supabase/client"
import { enabledProviders, PROVIDERS, type ProviderId } from "./providers"
import { emailLinkRedirect } from "./returnPath"

/**
 * "Continue with GitHub" and "Continue with Google", for the providers Auth
 * has on. The provider sends the person back to the sign-in page with `next`,
 * as the emailed link does. Offline, or when Auth's settings cannot be read,
 * nothing shows.
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
    <Card>
      <CardContent className="flex flex-col gap-3">
        {PROVIDERS.filter((provider) => providers.includes(provider.id)).map((provider) => (
          <Button key={provider.id} type="button" variant="outline" onClick={() => void continueWith(provider.id)}>
            {provider.label}
          </Button>
        ))}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}
