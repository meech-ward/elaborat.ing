/**
 * Settings > Account > Password: set a password to sign in with alongside the
 * email (someone who signed up by link or passkey has none yet), or change
 * it. When the session is more than a day old, Auth first emails a code
 * (`secure_password_change` in supabase/config.toml), and the form asks for
 * it. The database refuses this change from an agent's session
 * (supabase/schemas/auth_guards.sql).
 */
import { useId, useState, type FormEvent } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Banner } from "@/features/design-system"
import { PASSWORD_RULE, passwordErrorMessage } from "@/features/auth/passwords"
import { loadedClient } from "@/lib/supabase/client"

export function PasswordForm({ email }: { email: string }) {
  const id = useId()
  const hintId = useId()
  const codeId = useId()
  const [password, setPassword] = useState("")
  // null until Auth asks for the emailed code.
  const [code, setCode] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<{ tone: "info" | "danger"; text: string } | null>(null)

  const sendCode = async () => {
    setNotice(null)
    const { error } = await loadedClient().auth.reauthenticate()
    if (error) {
      setNotice({ tone: "danger", text: `Could not send a code: ${error.message}` })
      return
    }
    setCode("")
    setNotice({ tone: "info", text: `To save it, enter the code we emailed to ${email}.` })
  }

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (saving || !password) return
    setSaving(true)
    setNotice(null)
    const nonce = code?.trim()
    const { error } = await loadedClient().auth.updateUser(nonce ? { password, nonce } : { password })
    if (error?.code === "reauthentication_needed") {
      await sendCode()
      setSaving(false)
      return
    }
    setSaving(false)
    if (error) {
      setNotice({ tone: "danger", text: passwordErrorMessage(error) })
      return
    }
    setPassword("")
    setCode(null)
    setNotice({ tone: "info", text: "Password saved. You can sign in with your email and this password." })
  }

  return (
    <form onSubmit={(event) => void save(event)} className="grid gap-2 border-t border-border pt-3">
      <h4 className="text-[13px] font-medium">Password</h4>
      {/* Tells a password manager which account the new password is for. */}
      <input type="text" name="username" autoComplete="username" value={email} readOnly hidden />
      <Label htmlFor={id} className="text-[13px] font-normal text-foreground">
        New password
      </Label>
      <Input
        id={id}
        type="password"
        autoComplete="new-password"
        required
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        aria-describedby={hintId}
      />
      <p id={hintId} className="text-xs text-muted-foreground">
        Sign in with your email and a password, as well as any other way you use. {PASSWORD_RULE}
      </p>
      {code !== null ? (
        <>
          <Label htmlFor={codeId} className="text-[13px] font-normal text-foreground">
            Code from the email
          </Label>
          <Input
            id={codeId}
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
        </>
      ) : null}
      {notice ? <Banner tone={notice.tone}>{notice.text}</Banner> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="outline" size="sm" disabled={saving || !password}>
          {saving ? "Saving..." : "Save password"}
        </Button>
        {code !== null ? (
          <Button type="button" variant="link" size="sm" onClick={() => void sendCode()}>
            Send a new code
          </Button>
        ) : null}
      </div>
    </form>
  )
}
