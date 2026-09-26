import { Link, useNavigate } from "@tanstack/react-router"
import { useCallback, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { projectHref } from "@/features/navigation"
import { libraryFor, useLibraryState, type ProjectAccount } from "./account"
import { statusLabel } from "./statusLabel"
import { useBackgroundRefresh } from "./useBackgroundRefresh"

/** The account's projects, and a way to start a new one. */
export function ProjectList({ account }: { account: ProjectAccount }) {
  const library = libraryFor(account)
  const state = useLibraryState(library)
  const navigate = useNavigate()
  const [title, setTitle] = useState("")
  const [error, setError] = useState<string | null>(null)
  const onError = useCallback((message: string) => setError(message), [])
  useBackgroundRefresh(library, onError)

  const create = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    try {
      const id = await library.create(title)
      setTitle("")
      await navigate({ href: projectHref(id) })
      void library.syncProject(id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <section aria-labelledby="projects-heading" className="flex flex-col gap-4">
      <h2 id="projects-heading" className="text-xl font-semibold">
        Your projects
      </h2>
      {!account.online || state.offline ? (
        <p role="status" className="text-sm text-muted-foreground">
          Offline: showing the projects on this device. Changes sync when you are back online.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {state.loaded && state.entries.length === 0 ? <p className="text-sm">No projects yet.</p> : null}
      <ul className="flex flex-col divide-y rounded-lg border">
        {state.entries.map((entry) => (
          <li key={entry.id} className="flex items-center justify-between gap-4 px-4 py-3">
            <Link to={projectHref(entry.id)} className="font-medium underline-offset-4 hover:underline">
              {entry.title}
            </Link>
            <span className="text-sm text-muted-foreground">{statusLabel(entry)}</span>
          </li>
        ))}
      </ul>
      <form onSubmit={create} className="flex items-end gap-2">
        <div className="grid flex-1 gap-2">
          <Label htmlFor="new-project-title">New project</Label>
          <Input id="new-project-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Project title" />
        </div>
        <Button type="submit">Create</Button>
      </form>
    </section>
  )
}
