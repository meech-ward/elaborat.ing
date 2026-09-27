import { createContext, useContext, type ReactNode } from "react"
import type { User } from "@supabase/supabase-js"
import { Button } from "@/components/ui/button"
import { retryAuth, useAuth } from "./useAuth"

export type Account = { user: User; email: string | null; connectivityError?: string }

const AccountContext = createContext<Account | null>(null)

/** The signed-in account, inside an `AuthGate`; otherwise null. */
export function useAccount(): Account | null {
  return useContext(AccountContext)
}

/**
 * Shows `children` only to someone signed in. Loading, sign-in and failure are
 * visible states; `signedOut` is what a signed-out visitor sees (such as a
 * sign-in link, or projects kept on this device).
 */
export function AuthGate({ children, signedOut }: { children: ReactNode; signedOut: ReactNode }) {
  const state = useAuth()
  if (state.status === "unconfigured") {
    return (
      <p role="alert" className="p-6 text-sm">
        This copy of elaborat.ing is not connected to a Supabase project yet.
      </p>
    )
  }
  if (state.status === "loading") {
    return (
      <p role="status" className="p-6 text-sm text-muted-foreground">
        Checking your session...
      </p>
    )
  }
  if (state.status === "signed-out") return <>{signedOut}</>
  if (state.status === "error") {
    return (
      <div className="mx-auto flex max-w-sm flex-col gap-3 p-6">
        <p role="alert" className="text-sm">
          {state.message}
        </p>
        <Button variant="outline" onClick={retryAuth}>
          Try again
        </Button>
        {signedOut}
      </div>
    )
  }
  return (
    <AccountContext.Provider value={{ user: state.user, email: state.email, connectivityError: state.connectivityError }}>
      {children}
    </AccountContext.Provider>
  )
}
