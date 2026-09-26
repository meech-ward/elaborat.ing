import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { createClient } from "@/lib/supabase/client"
import { emailLinkRedirect } from "./returnPath"

/** Sign in without a password: Supabase emails a one-time sign-in link. */
export function MagicLinkForm({ next }: { next: string | null }) {
  const [email, setEmail] = useState("")
  const [status, setStatus] = useState<"idle" | "sending" | "sent">("idle")
  const [error, setError] = useState<string | null>(null)

  const send = async (event: React.FormEvent) => {
    event.preventDefault()
    setStatus("sending")
    setError(null)
    const { error } = await createClient().auth.signInWithOtp({
      email,
      options: { emailRedirectTo: emailLinkRedirect(window.location.origin, next) },
    })
    if (error) {
      setError(error.message)
      setStatus("idle")
      return
    }
    setStatus("sent")
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Email me a link</CardTitle>
        <CardDescription>No password needed. We'll email you a link that signs you in.</CardDescription>
      </CardHeader>
      <CardContent>
        {status === "sent" ? (
          <p role="status" className="text-sm">
            Check {email} for your sign-in link. It works once, for one hour.
          </p>
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
