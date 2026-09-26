import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { signOut, useAuth } from "./useAuth"

/** Who is signed in, with a way out; or a way in. Nothing when the build has no Supabase project. */
export function AccountHeader() {
  const state = useAuth()
  const [error, setError] = useState<string | null>(null)
  if (state.status === "unconfigured" || state.status === "loading") return null
  return (
    <header className="flex items-center justify-end gap-3 px-6 py-3 text-sm">
      {state.status === "ready" ? (
        <>
          <span>
            Signed in as <strong>{state.email}</strong>
          </span>
          <Link to="/agents" className="underline underline-offset-4">
            Connected agents
          </Link>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setError(null)
              void signOut().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
            }}
          >
            Sign out
          </Button>
          {error ? (
            <span role="alert" className="text-destructive">
              Not signed out: {error}
            </span>
          ) : null}
        </>
      ) : (
        <Link to="/sign-in" className="underline underline-offset-4">
          Sign in
        </Link>
      )}
    </header>
  )
}
