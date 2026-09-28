/**
 * Settings > Passkeys: the signed-in person's passkeys, from Supabase Auth,
 * with "Add a passkey" and a way to remove each. Shows only when Auth has
 * passkey sign-in on and the browser supports passkeys.
 */
import { KeyRound } from "lucide-react"
import { useEffect, useState } from "react"
import type { PasskeyListItem } from "@supabase/supabase-js"
import { Button } from "@/components/ui/button"
import { Banner, BannerAction } from "@/features/design-system"
import { browserSupportsPasskeys, passkeyErrorMessage } from "@/features/auth/passkeys"
import { signInOptions } from "@/features/auth/providers"
import { useAuth } from "@/features/auth/useAuth"
import { parseConfig } from "@/lib/config"
import { createClient } from "@/lib/supabase/client"

type List = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; passkeys: PasskeyListItem[] }

const onDate = (at: string) => new Date(at).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })

export function PasskeysSection() {
  const account = useAuth()
  const [available, setAvailable] = useState(false)
  useEffect(() => {
    if (account.status !== "ready" || !browserSupportsPasskeys()) return
    let alive = true
    signInOptions(parseConfig(import.meta.env)).then(
      (options) => {
        if (alive) setAvailable(options.passkeys)
      },
      () => {},
    )
    return () => {
      alive = false
    }
  }, [account.status])
  if (account.status !== "ready" || !available) return null
  return <Passkeys />
}

function Passkeys() {
  const [list, setList] = useState<List>({ status: "loading" })
  const [attempt, setAttempt] = useState(0)
  const [notice, setNotice] = useState<{ tone: "info" | "danger"; text: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void createClient()
      .auth.passkey.list()
      .then(({ data, error }) => {
        if (alive) setList(error ? { status: "error", message: error.message } : { status: "ready", passkeys: data ?? [] })
      })
    return () => {
      alive = false
    }
  }, [attempt])

  const add = async () => {
    setBusy("add")
    setNotice(null)
    const { data, error } = await createClient().auth.registerPasskey()
    setBusy(null)
    if (error || !data) {
      setNotice({ tone: "danger", text: error ? passkeyErrorMessage(error, "add") : "No passkey was added." })
      return
    }
    setList((current) => (current.status === "ready" ? { status: "ready", passkeys: [...current.passkeys, data] } : current))
    setNotice({ tone: "info", text: "Passkey added. You can sign in with it now." })
  }

  const remove = async (passkey: PasskeyListItem) => {
    setBusy(passkey.id)
    setNotice(null)
    const { error } = await createClient().auth.passkey.delete({ passkeyId: passkey.id })
    setBusy(null)
    if (error) {
      setNotice({ tone: "danger", text: `Could not remove the passkey: ${error.message}` })
      return
    }
    setList((current) => (current.status === "ready" ? { status: "ready", passkeys: current.passkeys.filter((entry) => entry.id !== passkey.id) } : current))
    setNotice({ tone: "info", text: "Passkey removed." })
  }

  return (
    <section aria-labelledby="settings-passkeys" className="grid gap-3">
      <h3 id="settings-passkeys" className="text-sm font-semibold">
        Passkeys
      </h3>
      <p className="text-xs text-muted-foreground">Sign in with your fingerprint, face or device PIN. Passkeys belong to your account, on every device.</p>
      {list.status === "loading" ? (
        <p role="status" className="text-[13px] text-muted-foreground">
          Loading passkeys...
        </p>
      ) : list.status === "error" ? (
        <Banner
          tone="danger"
          action={
            <BannerAction
              onClick={() => {
                setList({ status: "loading" })
                setAttempt((value) => value + 1)
              }}
            >
              Try again
            </BannerAction>
          }
        >
          Could not load your passkeys: {list.message}
        </Banner>
      ) : list.passkeys.length === 0 ? (
        <p className="text-[13px]">No passkeys yet.</p>
      ) : (
        <ul aria-label="Passkeys" className="flex flex-col divide-y divide-border rounded-tile border border-border">
          {list.passkeys.map((passkey) => {
            const name = passkey.friendly_name || "Passkey"
            return (
              <li key={passkey.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-[13px] font-medium break-words">{name}</span>
                  <span className="text-xs text-muted-foreground">
                    Added {onDate(passkey.created_at)}
                    {passkey.last_used_at ? `, last used ${onDate(passkey.last_used_at)}` : ""}
                  </span>
                </div>
                <Button variant="outline" size="sm" aria-label={`Remove ${name}`} disabled={busy !== null} onClick={() => void remove(passkey)}>
                  {busy === passkey.id ? "Removing..." : "Remove"}
                </Button>
              </li>
            )
          })}
        </ul>
      )}
      {notice ? <Banner tone={notice.tone}>{notice.text}</Banner> : null}
      <div>
        <Button variant="outline" size="sm" disabled={busy !== null || list.status !== "ready"} onClick={() => void add()}>
          <KeyRound data-icon="inline-start" aria-hidden="true" />
          {busy === "add" ? "Adding..." : "Add a passkey"}
        </Button>
      </div>
    </section>
  )
}
