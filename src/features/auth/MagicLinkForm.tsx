import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { createClient } from "@/lib/supabase/client"
import { emailLinkRedirect } from "./returnPath"

/**
 * Sign in without a password: Supabase emails a one-time sign-in link, and
 * the same email carries a code that signs in here instead. The sign-in page
 * continues to `next` once there is a session, however it came.
 */
export function MagicLinkForm({ next }: { next: string | null }) {
  const [email, setEmail] = useState("")
  const [status, setStatus] = useState<"idle" | "sending" | "sent">("idle")
  const [code, setCode] = useState("")
  const [verifying, setVerifying] = useState(false)
  const [resent, setResent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const sendEmail = () =>
    createClient().auth.signInWithOtp({
      email,
      options: { emailRedirectTo: emailLinkRedirect(window.location.origin, next) },
    })

  const send = async (event: React.FormEvent) => {
    event.preventDefault()
    setStatus("sending")
    setError(null)
    const { error } = await sendEmail()
    if (error) {
      setError(error.message)
      setStatus("idle")
      return
    }
    setStatus("sent")
  }

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
    const { error } = await sendEmail()
    if (error) setError(error.message)
    else setResent(true)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Email me a link</CardTitle>
        <CardDescription>No password needed. We'll email you a link that signs you in, and a code you can enter here instead.</CardDescription>
      </CardHeader>
      <CardContent>
        {status === "sent" ? (
          <form onSubmit={verify} className="flex flex-col gap-4">
            <p role="status" className="text-sm">
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
            <Button type="submit" disabled={verifying}>
              {verifying ? "Signing in..." : "Sign in with the code"}
            </Button>
            <Button type="button" variant="outline" onClick={() => void resend()}>
              Send a new link and code
            </Button>
          </form>
        ) : (
          <form onSubmit={send} className="flex flex-col gap-4">
            <div className="grid gap-2">
              <Label htmlFor="magic-email">Email</Label>
              <Input id="magic-email" type="email" required autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} />
            </div>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <Button type="submit" variant="outline" disabled={status === "sending"}>
              {status === "sending" ? "Sending..." : "Email me a sign-in link"}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  )
}
