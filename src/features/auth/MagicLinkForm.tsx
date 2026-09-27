import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { createClient } from "@/lib/supabase/client"
import { emailLinkRedirect } from "./returnPath"

/**
 * Sign in without a password: Supabase emails a one-time sign-in link, and
 * the same email carries a code that signs in on the page instead. The
 * sign-in page continues to `next` once there is a session, however it came.
 */
export function sendSignInEmail(email: string, next: string | null) {
  return createClient().auth.signInWithOtp({
    email,
    options: { emailRedirectTo: emailLinkRedirect(window.location.origin, next) },
  })
}

/** After the email is sent: enter its code, send a new one, or start again with another email. */
export function EmailCodeStep({ email, next, onBack }: { email: string; next: string | null; onBack: () => void }) {
  const [code, setCode] = useState("")
  const [verifying, setVerifying] = useState(false)
  const [resent, setResent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const verify = async (event: React.FormEvent) => {
    event.preventDefault()
    setVerifying(true)
    setError(null)
    setResent(false)
    const { error } = await createClient().auth.verifyOtp({ email, token: code.trim(), type: "email" })
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
      <p role="status" className="text-sm [overflow-wrap:anywhere]">
        {resent
          ? `Sent a new link and code to ${email}.`
          : `Check ${email} for your sign-in link. It works once, for one hour. The email also has a code you can enter here.`}
      </p>
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
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="submit" size="lg" className="w-full" disabled={verifying}>
        {verifying ? "Signing in..." : "Sign in with the code"}
      </Button>
      <Button type="button" variant="outline" size="lg" className="w-full" onClick={() => void resend()}>
        Send a new link and code
      </Button>
      <button type="button" className="self-start text-sm text-(--link) underline underline-offset-4" onClick={onBack}>
        Use a different email
      </button>
    </form>
  )
}
