import type { Session } from "@supabase/supabase-js"
import { useEffect, useState } from "react"
import { createClient, supabaseConfigured } from "@/lib/supabase/client"

export type SessionState = { status: "loading" } | { status: "signed-out" } | { status: "signed-in"; session: Session } | { status: "unconfigured" }

/** The current Supabase session, kept up to date. */
export function useSession(): SessionState {
  const [state, setState] = useState<SessionState>(() => (supabaseConfigured() ? { status: "loading" } : { status: "unconfigured" }))
  useEffect(() => {
    if (!supabaseConfigured()) return
    const supabase = createClient()
    let active = true
    void supabase.auth.getSession().then(({ data }) => {
      if (active) setState(data.session ? { status: "signed-in", session: data.session } : { status: "signed-out" })
    })
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      setState(session ? { status: "signed-in", session } : { status: "signed-out" })
    })
    return () => {
      active = false
      data.subscription.unsubscribe()
    }
  }, [])
  return state
}
