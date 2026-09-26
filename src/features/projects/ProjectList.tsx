import { Menu } from "@base-ui/react/menu"
import { Link, useNavigate } from "@tanstack/react-router"
import { Ellipsis } from "lucide-react"
import { useCallback, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { projectHref } from "@/features/navigation"
import type { Invitation, ProjectEntry } from "@/features/project-storage/library"
import { libraryFor, useLibraryState, type ProjectAccount } from "./account"
import { ImportProject } from "./ImportProject"
import { statusLabel } from "./statusLabel"
import { useBackgroundRefresh } from "./useBackgroundRefresh"

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** A shared project's menu: leaving it, for now. */
function ProjectMenu({ title, onLeave }: { title: string; onLeave: () => void }) {
  return (
    <Menu.Root>
      <Menu.Trigger render={<Button variant="ghost" size="icon" aria-label={`Actions for ${title}`} title={`Actions for ${title}`} />}>
        <Ellipsis aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={4} align="end" className="z-50">
          <Menu.Popup className="min-w-40 rounded-lg border bg-popover p-1 text-sm text-popover-foreground shadow-md">
            <Menu.Item className="cursor-default rounded-md px-2 py-1.5 outline-none data-highlighted:bg-accent" onClick={onLeave}>
              Leave project
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}

/** The account's projects and invitations, and ways to start a new one or import one. */
export function ProjectList({ account }: { account: ProjectAccount }) {
  const library = libraryFor(account)
  const state = useLibraryState(library)
  const navigate = useNavigate()
  const [title, setTitle] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const onError = useCallback((text: string) => setError(text), [])
  useBackgroundRefresh(library, onError, { invitations: true })

  const accept = async (invitation: Invitation) => {
    setError(null)
    setNotice(null)
    try {
      await library.accept(invitation.projectId)
      await navigate({ href: projectHref(invitation.projectId) })
    } catch (cause) {
      setError(`Not accepted: ${message(cause)}`)
    }
  }

  const leave = async (entry: ProjectEntry) => {
    setError(null)
    setNotice(null)
    try {
      // Say what would be lost before asking, and ask before anything changes.
      const problem = await library.leaveProblem(entry.id)
      if (problem) {
        setError(problem)
        return
      }
      if (!window.confirm(`Leave ${entry.title}? You lose access to it, and it is removed from this device. Its owner can invite you again.`)) return
      await library.leave(entry.id)
      setNotice(`Left ${entry.title}.`)
    } catch (cause) {
      setError(message(cause))
    }
  }

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
      {notice ? (
        <p role="status" className="text-sm">
          {notice}
        </p>
      ) : null}
      {state.invitations.length > 0 ? (
        <section aria-labelledby="invitations-heading" className="flex flex-col gap-2">
          <h3 id="invitations-heading" className="font-medium">
            Invitations
          </h3>
          <ul className="flex flex-col divide-y rounded-lg border">
            {state.invitations.map((invitation) => (
              <li key={invitation.projectId} className="flex items-center justify-between gap-4 px-4 py-3">
                <span>
                  <span className="font-medium">{invitation.title}</span>
                  <span className="text-sm text-muted-foreground">, as {invitation.role}</span>
                </span>
                <Button size="sm" aria-label={`Accept the invitation to ${invitation.title}`} onClick={() => void accept(invitation)}>
                  Accept
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {state.loaded && state.entries.length === 0 ? <p className="text-sm">No projects yet.</p> : null}
      <ul className="flex flex-col divide-y rounded-lg border">
        {state.entries.map((entry) => (
          <li key={entry.id} className="flex items-center justify-between gap-4 px-4 py-3">
            <Link to={projectHref(entry.id)} className="font-medium underline-offset-4 hover:underline">
              {entry.title}
            </Link>
            <span className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">{statusLabel(entry)}</span>
              {entry.role !== null && entry.role !== "owner" ? <ProjectMenu title={entry.title} onLeave={() => void leave(entry)} /> : null}
            </span>
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
      <ImportProject library={library} />
    </section>
  )
}
