/**
 * Settings > Account: the name the signed-in person shows under, with their
 * comments and in a project's members. It is kept in their Auth user
 * metadata (`display_name`), set here from their own session; agents have no
 * way to change it. Without one, the name their sign-in provider gave shows,
 * else their email. Below it, Password (PasswordForm.tsx) and Delete account
 * (DeleteAccountDialog.tsx).
 */
import type { User } from "@supabase/supabase-js"
import { useId, useState, type FormEvent } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Banner } from "@/features/design-system"
import { accountName, DISPLAY_NAME_KEY, NAME_MAX_LENGTH } from "@/features/auth/accountName"
import { useAuth } from "@/features/auth/useAuth"
import { loadedClient } from "@/lib/supabase/client"
import { DeleteAccountDialog } from "./DeleteAccountDialog"
import { PasswordForm } from "./PasswordForm"

export function AccountSection({ onDeleted }: { onDeleted: () => void }) {
  const account = useAuth()
  if (account.status !== "ready") return null
  return <YourName key={account.user.id} user={account.user} onDeleted={onDeleted} />
}

function YourName({ user, onDeleted }: { user: User; onDeleted: () => void }) {
  const id = useId()
  const hintId = useId()
  const saved = accountName(user.user_metadata) ?? ""
  const [value, setValue] = useState(saved)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<{ tone: "info" | "danger"; text: string } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const name = value.replace(/\s+/g, " ").trim()

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (saving || name === saved) return
    setSaving(true)
    setNotice(null)
    const { error } = await loadedClient().auth.updateUser({ data: { [DISPLAY_NAME_KEY]: name || null } })
    setSaving(false)
    if (error) {
      setNotice({ tone: "danger", text: `Could not save your name: ${error.message}` })
      return
    }
    // Without a name of their own, the one their sign-in provider gave shows again.
    setValue(accountName({ ...user.user_metadata, [DISPLAY_NAME_KEY]: name || null }) ?? "")
    setNotice({ tone: "info", text: name ? "Name saved." : "Name removed." })
  }

  return (
    <section aria-labelledby="settings-account" className="grid gap-3">
      <h3 id="settings-account" className="text-sm font-semibold">
        Account
      </h3>
      <form onSubmit={(event) => void save(event)} className="grid gap-2">
        <Label htmlFor={id} className="text-[13px] font-normal text-foreground">
          Your name
        </Label>
        <div className="flex gap-2">
          <Input
            id={id}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            maxLength={NAME_MAX_LENGTH}
            autoComplete="name"
            placeholder={user.email ?? undefined}
            aria-describedby={hintId}
            className="min-w-0 flex-1"
          />
          <Button type="submit" variant="outline" disabled={saving || name === saved}>
            {saving ? "Saving..." : "Save"}
          </Button>
        </div>
        <p id={hintId} className="text-xs text-muted-foreground">
          Shown with your comments and to the people you share projects with. Without one, they see the name your sign-in provider gave, else your email.
        </p>
      </form>
      {notice ? <Banner tone={notice.tone}>{notice.text}</Banner> : null}
      {user.email ? <PasswordForm email={user.email} /> : null}
      {user.email ? (
        <div className="grid gap-2 border-t border-border pt-3">
          <h4 className="text-[13px] font-medium">Delete account</h4>
          <p className="text-xs text-muted-foreground">Deletes your account and the projects you own. You see what goes before anything is deleted.</p>
          <div>
            <Button variant="destructive" size="sm" onClick={() => setDeleting(true)}>
              Delete account...
            </Button>
          </div>
          <DeleteAccountDialog
            open={deleting}
            onOpenChange={setDeleting}
            userId={user.id}
            email={user.email}
            onDeleted={() => {
              setDeleting(false)
              onDeleted()
            }}
          />
        </div>
      ) : null}
    </section>
  )
}
