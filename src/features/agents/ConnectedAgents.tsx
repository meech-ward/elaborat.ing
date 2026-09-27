import { useEffect, useState } from "react"
import type { OAuthGrant } from "@supabase/supabase-js"
import { Button } from "@/components/ui/button"
import { createClient } from "@/lib/supabase/client"

type State = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; grants: OAuthGrant[] }

const connectedOn = (grantedAt: string) =>
  new Date(grantedAt).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })

/**
 * The agents (OAuth clients such as Claude or ChatGPT) the signed-in person
 * has approved, from Supabase Auth's OAuth server, with a way to disconnect
 * each. Disconnecting revokes the grant: Auth deletes the agent's sessions
 * and refresh tokens, and it needs a new approval to connect again.
 */
export function ConnectedAgents() {
  const [state, setState] = useState<State>({ status: "loading" })
  const [attempt, setAttempt] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)
  const [disconnecting, setDisconnecting] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void createClient()
      .auth.oauth.listGrants()
      .then(({ data, error }) => {
        if (alive) setState(error ? { status: "error", message: error.message } : { status: "ready", grants: data ?? [] })
      })
    return () => {
      alive = false
    }
  }, [attempt])

  const disconnect = async (grant: OAuthGrant) => {
    const name = grant.client.name || "this agent"
    if (!window.confirm(`Disconnect ${name}? It stops working with your account now, and needs your approval to connect again.`)) return
    setDisconnecting(grant.client.id)
    setNotice(null)
    const { error } = await createClient().auth.oauth.revokeGrant({ clientId: grant.client.id })
    setDisconnecting(null)
    if (error) {
      setNotice(`Could not disconnect ${name}: ${error.message}`)
      return
    }
    setState((current) =>
      current.status === "ready" ? { status: "ready", grants: current.grants.filter((entry) => entry.client.id !== grant.client.id) } : current,
    )
    setNotice(`Disconnected ${name}.`)
  }

  if (state.status === "loading") {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading connected agents...
      </p>
    )
  }
  if (state.status === "error") {
    return (
      <div className="flex flex-col items-start gap-3">
        <p role="alert" className="text-sm">
          Could not load connected agents: {state.message}
        </p>
        <Button
          variant="outline"
          onClick={() => {
            setState({ status: "loading" })
            setAttempt((value) => value + 1)
          }}
        >
          Try again
        </Button>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        An agent you approve acts as you: it can open and change every project you can. Disconnect one to stop that at once.
      </p>
      {notice ? (
        <p role="status" className="text-sm">
          {notice}
        </p>
      ) : null}
      {state.grants.length === 0 ? (
        <p className="text-sm">No agents are connected. When you approve one, such as Claude or ChatGPT, it shows here.</p>
      ) : (
        <ul aria-label="Connected agents" className="flex flex-col divide-y divide-border rounded-[10px] border border-border">
          {state.grants.map((grant) => (
            <li key={grant.client.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="flex min-w-0 flex-col gap-1">
                <span className="font-medium break-words">{grant.client.name || "Unnamed agent"}</span>
                {grant.client.uri ? (
                  <a href={grant.client.uri} target="_blank" rel="noopener noreferrer" className="text-sm break-all text-(--link) underline underline-offset-4">
                    {grant.client.uri}
                  </a>
                ) : null}
                <span className="text-sm text-muted-foreground">Connected on {connectedOn(grant.granted_at)}</span>
              </div>
              <Button
                variant="outline"
                aria-label={`Disconnect ${grant.client.name || "this agent"}`}
                disabled={disconnecting !== null}
                onClick={() => void disconnect(grant)}
              >
                {disconnecting === grant.client.id ? "Disconnecting..." : "Disconnect"}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
