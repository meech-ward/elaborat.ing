import { ProjectList } from "./ProjectList"
import { Welcome } from "./Welcome"
import { useProjectAccount } from "./account"
import { useSearch } from "@tanstack/react-router"
import { categorySelection } from "./categorySelection"

/**
 * The home page's body: the account's projects, or, signed out, what the
 * app is and the ways in. Nothing while the session is checked (the top bar
 * says so).
 */
export function ProjectsHome() {
  const result = useProjectAccount()
  const search = useSearch({ strict: false })
  if (result.kind === "account") return <ProjectList key={result.account.userId} account={result.account} categorySelection={categorySelection(search.category)} />
  if (result.kind === "loading") return null
  return <Welcome configured={result.kind !== "unconfigured"} />
}
