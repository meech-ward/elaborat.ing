import { Link, useMatchRoute, useNavigate } from "@tanstack/react-router"
import { Settings } from "lucide-react"
import { useState } from "react"
import { buttonVariants } from "@/components/ui/button"
import { AccountPill, AppBar, Banner, IconButton } from "@/features/design-system"
import { projectHref } from "@/features/navigation"
import { LOCAL_PROJECT_ID } from "@/features/project-storage/localProject"
import { useOpenSettings } from "@/features/settings/SettingsDialog"
import { cn } from "@/lib/utils"
import { signOut, useAuth } from "./useAuth"

/**
 * The top bar of the pages outside a project, which makes plain whether you
 * are signed in. Signed in, the account (its avatar and email) opens a menu
 * with Settings, Connected agents and Sign out; signed out, Settings, a way
 * in (except on the sign-in page itself), and a way to start writing without
 * an account (in the local project).
 * The right side is left out when the build has no Supabase project.
 */
export function AccountHeader() {
  const state = useAuth()
  const openSettings = useOpenSettings()
  const navigate = useNavigate()
  const onSignIn = Boolean(useMatchRoute()({ to: "/sign-in" }))
  const [error, setError] = useState<string | null>(null)
  const home = <Link to="/" />
  if (state.status === "unconfigured") return <AppBar home={home} />

  const settings = (
    <IconButton label="Settings" onClick={openSettings}>
      <Settings />
    </IconButton>
  )
  if (state.status === "ready") {
    return (
      <AppBar
        home={home}
        actions={
          <AccountPill
            email={state.email ?? "your account"}
            menu={[
              { label: "Settings", onSelect: openSettings },
              { label: "Connected agents", onSelect: () => void navigate({ to: "/agents" }) },
              {
                label: "Sign out",
                group: "account",
                onSelect: () => {
                  setError(null)
                  void signOut().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
                },
              },
            ]}
          />
        }
        below={error && <Banner tone="danger">Not signed out: {error}</Banner>}
      />
    )
  }
  if (state.status === "loading") {
    return (
      <AppBar
        home={home}
        actions={
          <>
            <p role="status" className="px-2 text-[13px] text-muted-foreground">
              Checking your session...
            </p>
            {settings}
          </>
        }
      />
    )
  }
  return (
    <AppBar
      home={home}
      actions={
        <>
          {settings}
          {!onSignIn && (
            <Link to="/sign-in" className={buttonVariants({ variant: "ghost" })}>
              Sign in
            </Link>
          )}
          {/* Phones have Start writing on the page, under the headline. */}
          <Link to={projectHref(LOCAL_PROJECT_ID)} className={cn(buttonVariants(), "max-sm:hidden")}>
            Start writing
          </Link>
        </>
      }
      below={state.status === "error" && <Banner tone="warn">{state.message}</Banner>}
    />
  )
}
