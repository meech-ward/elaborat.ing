import { KeyRound } from "lucide-react"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Banner } from "@/features/design-system"
import { parseConfig } from "@/lib/config"
import { createClient } from "@/lib/supabase/client"
import { browserSupportsPasskeys, passkeyErrorMessage } from "./passkeys"
import { PROVIDERS, signInOptions, type ProviderId, type SignInOptions } from "./providers"
import { emailLinkRedirect } from "./returnPath"

/**
 * "Sign in with a passkey", "Continue with GitHub" and "Continue with
 * Google", under an "or", for the methods Auth has on (a passkey only where
 * the browser supports them). The provider sends the person back to the
 * sign-in page with `next`, as the emailed link does; a passkey signs in on
 * the spot and goes to `next`. Offline, or when Auth's settings cannot be
 * read, nothing shows.
 */
export function ProviderButtons({ next }: { next: string | null }) {
  const [options, setOptions] = useState<SignInOptions>({ providers: [], passkeys: false })
  const [error, setError] = useState<string | null>(null)
  const [signingIn, setSigningIn] = useState(false)
  useEffect(() => {
    let alive = true
    signInOptions(parseConfig(import.meta.env)).then(
      (enabled) => {
        if (alive) setOptions(enabled)
      },
      () => {},
    )
    return () => {
      alive = false
    }
  }, [])

  const passkeys = options.passkeys && browserSupportsPasskeys()
  if (options.providers.length === 0 && !passkeys) return null
  const signInWithPasskey = async () => {
    setError(null)
    setSigningIn(true)
    const { error } = await createClient().auth.signInWithPasskey()
    if (error) {
      setSigningIn(false)
      setError(passkeyErrorMessage(error, "sign-in"))
    }
    // Otherwise signed in: the sign-in page moves on once the session is confirmed (routes/sign-in.tsx).
  }
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
      {passkeys ? (
        <Button type="button" variant="outline" size="lg" className="w-full" disabled={signingIn} onClick={() => void signInWithPasskey()}>
          <KeyRound data-icon="inline-start" aria-hidden="true" />
          {signingIn ? "Signing in..." : "Sign in with a passkey"}
        </Button>
      ) : null}
      {PROVIDERS.filter((provider) => options.providers.includes(provider.id)).map((provider) => (
        <Button key={provider.id} type="button" variant="outline" size="lg" className="w-full" onClick={() => void continueWith(provider.id)}>
          {provider.label}
        </Button>
      ))}
      {error ? <Banner tone="danger">{error}</Banner> : null}
    </div>
  )
}
