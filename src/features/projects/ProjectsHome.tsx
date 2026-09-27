import { Link, useLocation } from "@tanstack/react-router"
import { PanelPage } from "@/components/panel"
import { parseProjectLocation } from "@/features/navigation"
import { LOCAL_PROJECT_ID } from "@/features/project-storage/localProject"
import { ProjectList } from "./ProjectList"
import { Welcome } from "./Welcome"
import { LOCAL_ACCOUNT, useProjectAccount } from "./account"

/**
 * The home page's body: the account's projects, or, signed out, what the
 * app is and the ways in. Nothing while the session is checked (the top bar
 * says so).
 */
export function ProjectsHome() {
  const result = useProjectAccount()
  if (result.kind === "account") return <ProjectList account={result.account} />
  if (result.kind === "loading") return null
  return <Welcome configured={result.kind !== "unconfigured"} />
}

/** Shows the project page for the account (the local project without one), or the reason it cannot. */
export function ProjectRoute({ children }: { children: (account: import("./account").ProjectAccount) => React.ReactNode }) {
  const result = useProjectAccount()
  const href = useLocation({ select: (location) => location.href })
  if (result.kind === "account") return <>{children(result.account)}</>
  const location = parseProjectLocation(href)
  if (result.kind === "signed-out" && location.kind === "project" && location.projectId === LOCAL_PROJECT_ID) return <>{children(LOCAL_ACCOUNT)}</>
  if (result.kind === "loading") {
    return (
      <PanelPage>
        <p role="status" className="text-muted-foreground">
          Checking your session...
        </p>
      </PanelPage>
    )
  }
  if (result.kind === "unconfigured") {
    return (
      <PanelPage>
        <p role="alert">This copy of elaborat.ing is not connected to a Supabase project yet.</p>
      </PanelPage>
    )
  }
  const next = typeof window === "undefined" ? "/" : `${window.location.pathname}${window.location.search}`
  return (
    <PanelPage>
      <p>
        <Link to="/sign-in" search={{ next }} className="text-(--accent-soft-text) underline underline-offset-4">
          Sign in
        </Link>{" "}
        to open this project.
      </p>
    </PanelPage>
  )
}
