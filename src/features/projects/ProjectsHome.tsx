import { Link } from "@tanstack/react-router"
import { ProjectList } from "./ProjectList"
import { useProjectAccount } from "./account"

/** The home page's projects section: the account's projects, or a way in. */
export function ProjectsHome() {
  const result = useProjectAccount()
  if (result.kind === "account") return <ProjectList account={result.account} />
  if (result.kind === "signed-out") {
    return (
      <p>
        <Link to="/sign-in" className="underline underline-offset-4">
          Sign in
        </Link>{" "}
        to see your projects.
      </p>
    )
  }
  return null
}

/** Shows the project page for the account, or the reason it cannot. */
export function ProjectRoute({ children }: { children: (account: import("./account").ProjectAccount) => React.ReactNode }) {
  const result = useProjectAccount()
  if (result.kind === "account") return <>{children(result.account)}</>
  if (result.kind === "loading") {
    return (
      <p role="status" className="p-6 text-sm text-muted-foreground">
        Checking your session...
      </p>
    )
  }
  if (result.kind === "unconfigured") {
    return (
      <p role="alert" className="p-6 text-sm">
        This copy of elaborat.ing is not connected to a Supabase project yet.
      </p>
    )
  }
  const next = typeof window === "undefined" ? "/" : `${window.location.pathname}${window.location.search}`
  return (
    <p className="p-6 text-sm">
      <Link to="/sign-in" search={{ next }} className="underline underline-offset-4">
        Sign in
      </Link>{" "}
      to open this project.
    </p>
  )
}
