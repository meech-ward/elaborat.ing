import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Banner } from "@/features/design-system"
import { loadClient } from "@/lib/supabase/client"
import { emailLinkRedirect } from "./returnPath"

/**
 * Sign in without a password: Supabase emails a one-time sign-in link, and
 * the same email carries a code that signs in on the page instead. The
 * sign-in page continues to `next` once there is a session, however it came.
 */
export async function sendSignInEmail(email: string, next: string | null) {
  return (await loadClient()).auth.signInWithOtp({
    email,
    options: { emailRedirectTo: emailLinkRedirect(window.location.origin, next) },
  })
}

/**
 * After the email is sent: enter its code, send a new one, or start again
 * with another email. `sentMessage` says what was sent, when it was not a
 * sign-in link (sign-up's confirmation).
 */
export function EmailCodeStep({ email, next, sentMessage, onBack }: { email: string; next: string | null; sentMessage?: string; onBack: () => void }) {
  const [code, setCode] = useState("")
  const [verifying, setVerifying] = useState(false)
  const [resent, setResent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const verify = async (event: React.FormEvent) => {
    event.preventDefault()
    setVerifying(true)
    setError(null)
    setResent(false)
    const { error } = await (await loadClient()).auth.verifyOtp({ email, token: code.trim(), type: "email" })
    setVerifying(false)
    if (error) setError(`That code did not work (${error.message}). Check it and try again, or send a new one.`)
  }

  const resend = async () => {
    setError(null)
    setResent(false)
    setCode("")
    const { error } = await sendSignInEmail(email, next)
    if (error) setError(error.message)
    else setResent(true)
  }

  return (
    <form onSubmit={verify} className="flex flex-col gap-4">
      <Banner tone="info" className="[overflow-wrap:anywhere]">
        {resent
          ? `Sent a new link and code to ${email}.`
          : (sentMessage ?? `Check ${email} for your sign-in link. It works once, for one hour. The email also has a code you can enter here.`)}
      </Banner>
      <div className="grid gap-2">
        <Label htmlFor="magic-code">Code from the email</Label>
        <Input
          id="magic-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          required
          value={code}
          onChange={(event) => setCode(event.target.value)}
        />
      </div>
      {error ? <Banner tone="danger">{error}</Banner> : null}
      <Button type="submit" size="lg" className="w-full" disabled={verifying}>
        {verifying ? "Signing in..." : "Sign in with the code"}
      </Button>
      <Button type="button" variant="outline" size="lg" className="w-full" onClick={() => void resend()}>
        Send a new link and code
      </Button>
      <Button type="button" variant="link" size="sm" className="-my-1 self-start px-0" onClick={onBack}>
        Use a different email
      </Button>
    </form>
  )
}
