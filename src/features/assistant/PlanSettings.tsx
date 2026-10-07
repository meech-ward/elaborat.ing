import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { ChatGPTButton, ChatGPTPlanLabel } from "@/features/design-system"
import { connectPlan, disconnectPlan, fetchPlanStatus, KeeperError, type PlanStatus } from "./api"

type State = { kind: "loading" } | { kind: "ready"; status: PlanStatus } | { kind: "failed"; message: string }

const messageOf = (error: unknown) => (error instanceof KeeperError || error instanceof Error ? error.message : String(error))

/**
 * Settings' "Use your ChatGPT plan" card (with VITE_CHATGPT_PLAN): Continue
 * with ChatGPT to connect, or the connected account with Manage usage and
 * Disconnect. Loads with Settings' sections.
 */
export function PlanSettings() {
  const [state, setState] = useState<State>({ kind: "loading" })
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    fetchPlanStatus().then(
      (status) => alive && setState({ kind: "ready", status }),
      (error: unknown) => alive && setState({ kind: "failed", message: messageOf(error) }),
    )
    return () => {
      alive = false
    }
  }, [])
  const status = state.kind === "ready" ? state.status : null
  const connected = Boolean(status?.connected && status.plan)
  return (
    <section aria-labelledby="settings-chatgpt" className="grid gap-3">
      <h3 id="settings-chatgpt" className="text-sm font-semibold">
        Use your ChatGPT plan
      </h3>
      <p className="text-[13px] text-muted-foreground">
        The assistant completes your requests in elaborat.ing with your ChatGPT plan. elaborat.ing charges nothing for it.
      </p>
      {state.kind === "loading" && <p className="text-[13px] text-muted-foreground">Checking your ChatGPT connection…</p>}
      {state.kind === "failed" && <p className="text-[13px] text-muted-foreground">{state.message}</p>}
      {status && !connected && (
        <div>
          <ChatGPTButton
            disabled={busy}
            onClick={() => {
              setBusy(true)
              connectPlan(status.connected && !status.plan).catch((error: unknown) => {
                setBusy(false)
                setNotice(messageOf(error))
              })
            }}
          />
        </div>
      )}
      {status && connected && (
        <>
          <p className="text-[13px]">Connected{status.email ? ` as ${status.email}` : ""}.</p>
          <ChatGPTPlanLabel />
          <div>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => {
                setBusy(true)
                disconnectPlan().then(
                  ({ revoked }) => {
                    setBusy(false)
                    setNotice(revoked ? "ChatGPT is disconnected." : "ChatGPT is disconnected here, but ChatGPT did not confirm it. You can also disconnect elaborat.ing in ChatGPT settings.")
                    setState({ kind: "ready", status: { ...status, connected: false, plan: false, models: [] } })
                  },
                  (error: unknown) => {
                    setBusy(false)
                    setNotice(messageOf(error))
                  },
                )
              }}
            >
              Disconnect
            </Button>
          </div>
        </>
      )}
      {notice && (
        <p role="status" className="text-xs text-muted-foreground">
          {notice}
        </p>
      )}
    </section>
  )
}
