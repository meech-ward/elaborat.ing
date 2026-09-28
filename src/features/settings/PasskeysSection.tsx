/**
 * Settings > Passkeys: the signed-in person's passkeys, from Supabase Auth,
 * with "Add a passkey" and a way to remove each, once confirmed. Shows only
 * when Auth has passkey sign-in on and the browser supports passkeys.
 */
import { KeyRound } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import type { PasskeyListItem } from "@supabase/supabase-js"
import { Button } from "@/components/ui/button"
import { AlertDialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
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
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)
  // The passkey whose Remove waits for the person to confirm it (kept while the confirmation closes).
  const [confirming, setConfirming] = useState<PasskeyListItem | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const addButton = useRef<HTMLButtonElement>(null)
  const confirmed = useRef(false)

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

  // A notice shows above Add a passkey, at the foot of a dialog that may scroll: keep both in sight.
  useEffect(() => {
    if (notice) addButton.current?.scrollIntoView({ block: "nearest" })
  }, [notice])

  const add = async () => {
    setAdding(true)
    setNotice(null)
    const { data, error } = await createClient().auth.registerPasskey()
    setAdding(false)
    if (error || !data) {
      setNotice({ tone: "danger", text: error ? passkeyErrorMessage(error, "add") : "No passkey was added." })
      return
    }
    setList((current) => (current.status === "ready" ? { status: "ready", passkeys: [...current.passkeys, data] } : current))
    setNotice({ tone: "info", text: "Passkey added. You can sign in with it now." })
  }

  const remove = async (passkey: PasskeyListItem) => {
    setRemoving(passkey.id)
    setNotice(null)
    const { error } = await createClient().auth.passkey.delete({ passkeyId: passkey.id })
    setRemoving(null)
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
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={`Remove ${name}`}
                  disabled={adding || removing !== null}
                  onClick={() => {
                    confirmed.current = false
                    setConfirming(passkey)
                    setConfirmOpen(true)
                  }}
                >
                  {removing === passkey.id ? "Removing..." : "Remove"}
                </Button>
              </li>
            )
          })}
        </ul>
      )}
      {notice ? <Banner tone={notice.tone}>{notice.text}</Banner> : null}
      <div>
        {/* Not off while a passkey is removed: the keyboard moves here from the confirmation. */}
        <Button ref={addButton} variant="outline" size="sm" disabled={adding || list.status !== "ready"} onClick={() => void add()}>
          <KeyRound data-icon="inline-start" aria-hidden="true" />
          {adding ? "Adding..." : "Add a passkey"}
        </Button>
      </div>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        {/* A removed passkey's row goes, so the keyboard moves on to Add a passkey; Cancel returns it to Remove. */}
        <DialogContent showCloseButton={false} finalFocus={() => (confirmed.current ? addButton.current : true)}>
          <DialogHeader>
            <DialogTitle>Remove {confirming?.friendly_name || "Passkey"}?</DialogTitle>
            <DialogDescription>It no longer signs you in, though your device may still offer it.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                confirmed.current = true
                setConfirmOpen(false)
                if (confirming) void remove(confirming)
              }}
            >
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </AlertDialog>
    </section>
  )
}
