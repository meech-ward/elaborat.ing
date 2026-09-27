import { Link } from "@tanstack/react-router"
import { Bot, Settings } from "lucide-react"
import { useState, type ReactNode } from "react"
import { panel } from "@/components/panel"
import { Button, buttonVariants } from "@/components/ui/button"
import { projectHref } from "@/features/navigation"
import { LOCAL_PROJECT_ID } from "@/features/project-storage/localProject"
import { useOpenSettings } from "@/features/settings/SettingsDialog"
import { cn } from "@/lib/utils"
import { signOut, useAuth } from "./useAuth"

/**
 * The page's header: `children` (the name, or a way back to it), then a panel
 * that makes plain whether you are signed in. Signed in, it shows the account
 * with Settings, Connected agents and Sign out; signed out, a way in, and a
 * way to start writing without an account (in the local project). The
 * panel is left out when the build has no Supabase project.
 */
export function AccountHeader({ children }: { children?: ReactNode }) {
  return (
    <header className="flex flex-col gap-4">
      {children}
      <AccountPanel />
    </header>
  )
}

function AccountPanel() {
  const state = useAuth()
  const openSettings = useOpenSettings()
  const [error, setError] = useState<string | null>(null)
  if (state.status === "unconfigured") return null
  const settings = (
    <Button variant="ghost" size="sm" onClick={openSettings}>
      <Settings aria-hidden="true" />
      Settings
    </Button>
  )
  if (state.status === "loading") {
    return (
      <div className={cn(panel, "flex min-h-16 items-center justify-between gap-3 px-4 py-3 text-sm")}>
        <p role="status" className="text-muted-foreground">
          Checking your session...
        </p>
        {settings}
      </div>
    )
  }
  if (state.status !== "ready") {
    return (
      <div className={cn(panel, "flex flex-col gap-3 p-4 text-sm")}>
        <div className="flex items-start justify-between gap-3">
          {state.status === "error" ? (
            <p className="font-semibold">{state.message}</p>
          ) : (
            <div className="flex flex-col gap-1">
              <p className="text-base font-semibold">You're not signed in</p>
              <p className="text-muted-foreground">Start writing without an account, or sign in to see your projects.</p>
            </div>
          )}
          {settings}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Link to={projectHref(LOCAL_PROJECT_ID)} className={buttonVariants()}>
            Start writing
          </Link>
          <Link to="/sign-in" className={buttonVariants({ variant: "outline" })}>
            Sign in
          </Link>
          <Link to="/sign-up" className="text-(--accent-soft-text) underline underline-offset-4">
            Create an account
          </Link>
        </div>
        <p className="text-muted-foreground">
          Without an account, your work is saved in this browser only, and is lost if the browser clears this site's data. Sign up and it moves to your
          account.
        </p>
      </div>
    )
  }
  const email = state.email ?? "your account"
  return (
    <div className={cn(panel, "flex flex-wrap items-center justify-between gap-3 p-4 text-sm")}>
      <div className="flex min-w-0 items-center gap-3">
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-semibold text-(--accent-soft-text)"
        >
          {email.charAt(0).toUpperCase()}
        </span>
        <p className="flex min-w-0 flex-col [overflow-wrap:anywhere]">
          <span className="text-xs text-muted-foreground">Signed in as</span>{" "}
          <strong className="font-semibold">{email}</strong>
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {settings}
        <Link to="/agents" className={buttonVariants({ variant: "ghost", size: "sm" })}>
          <Bot aria-hidden="true" />
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
      </div>
      {error ? (
        <p role="alert" className="w-full text-destructive">
          Not signed out: {error}
        </p>
      ) : null}
    </div>
  )
}
