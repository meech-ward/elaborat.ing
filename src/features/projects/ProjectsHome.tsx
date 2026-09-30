import { ProjectList } from "./ProjectList"
import { Welcome } from "./Welcome"
import { useProjectAccount } from "./account"

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
