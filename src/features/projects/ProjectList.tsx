import { Link, useNavigate } from "@tanstack/react-router"
import { Ellipsis } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { panel } from "@/components/panel"
import { ActionMenu, type MenuEntry } from "@/features/design-system"
import { projectHref } from "@/features/navigation"
import type { Invitation, ProjectEntry } from "@/features/project-storage/library"
import { canEdit } from "@/features/project-storage/model"
import { cn } from "@/lib/utils"
import { libraryFor, moveLocalProjectTo, useLibraryState, type ProjectAccount } from "./account"
import { DeleteProjectDialog } from "./DeleteProjectDialog"
import { ImportProject } from "./ImportProject"
import { MembersDialog } from "./MembersDialog"
import { statusLabel } from "./statusLabel"
import { useBackgroundRefresh } from "./useBackgroundRefresh"

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * A project's menu, by role: everyone sees its members, owners and editors
 * archive and unarchive, the owner deletes permanently, and anyone else can
 * leave.
 */
function ProjectMenu({ entry, onMembers, onArchive, onDelete, onLeave }: {
  entry: ProjectEntry
  onMembers: () => void
  /** Archive, or unarchive an archived project. */
  onArchive: () => void
  onDelete: () => void
  onLeave: () => void
}) {
  const items: MenuEntry[] = [
    { label: "Members", onSelect: onMembers },
    ...(canEdit(entry.role) ? [{ label: entry.archived ? "Unarchive" : "Archive", onSelect: onArchive }] : []),
    ...(entry.role === "owner" ? [{ label: "Delete permanently", onSelect: onDelete, destructive: true }] : [{ label: "Leave project", onSelect: onLeave }]),
  ]
  return (
    <ActionMenu
      entries={items}
      trigger={
        <Button variant="ghost" size="icon" aria-label={`Actions for ${entry.title}`} title={`Actions for ${entry.title}`}>
          <Ellipsis aria-hidden="true" />
        </Button>
      }
      contentProps={{ align: "end" }}
    />
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
  // The project to delete permanently, with how many of its files have changes not yet synced.
  const [deleting, setDeleting] = useState<{ entry: ProjectEntry; unsynced: number } | null>(null)
  // The project whose members are shown.
  const [membersOf, setMembersOf] = useState<ProjectEntry | null>(null)
  const onError = useCallback((text: string) => setError(text), [])
  useBackgroundRefresh(library, onError, { invitations: true })

  // Just signed in with work in the local project: it joins the account's projects and opens (the project page uploads it).
  useEffect(() => {
    if (!account.online) return
    let active = true
    moveLocalProjectTo(library)
      .then((id) => (id && active ? navigate({ href: projectHref(id) }) : undefined))
      .catch((cause: unknown) => active && setError(`The local project did not move to your account: ${message(cause)}`))
    return () => {
      active = false
    }
  }, [account.online, library, navigate])

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

  const setArchived = async (entry: ProjectEntry) => {
    setError(null)
    setNotice(null)
    try {
      if (entry.archived) {
        await library.unarchive(entry.id)
        setNotice(`Unarchived ${entry.title}.`)
      } else {
        await library.archive(entry.id)
        setNotice(`Archived ${entry.title}. It refuses changes until it is unarchived.`)
      }
    } catch (cause) {
      setError(`${entry.archived ? "Not unarchived" : "Not archived"}: ${message(cause)}`)
    }
  }

  const askToDelete = async (entry: ProjectEntry) => {
    setError(null)
    setNotice(null)
    try {
      setDeleting({ entry, unsynced: await library.unsyncedFiles(entry.id) })
    } catch (cause) {
      setError(message(cause))
    }
  }
  const deletePermanently = async (entry: ProjectEntry) => {
    await library.deletePermanently(entry.id)
    setDeleting(null)
    setNotice(`Deleted ${entry.title} permanently.`)
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

  const active = state.entries.filter((entry) => !entry.archived)
  const archived = state.entries.filter((entry) => entry.archived)
  const row = (entry: ProjectEntry) => (
    <li key={entry.id} className="flex min-h-10 items-center justify-between gap-3 py-1">
      <Link to={projectHref(entry.id)} className="min-w-0 font-medium [overflow-wrap:anywhere] underline-offset-4 hover:underline">
        {entry.title}
      </Link>
      <span className="flex shrink-0 items-center gap-2">
        <span className="text-xs text-muted-foreground">{statusLabel(entry)}</span>
        {entry.role !== null ? (
          <ProjectMenu
            entry={entry}
            onMembers={() => {
              setError(null)
              setNotice(null)
              setMembersOf(entry)
            }}
            onArchive={() => void setArchived(entry)}
            onDelete={() => void askToDelete(entry)}
            onLeave={() => void leave(entry)}
          />
        ) : null}
      </span>
    </li>
  )

  return (
    <section aria-labelledby="projects-heading" className={cn(panel, "flex flex-col gap-4 p-5")}>
      <h2 id="projects-heading" className="text-lg font-semibold">
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
          <h3 id="invitations-heading" className="text-sm font-semibold text-muted-foreground">
            Invitations
          </h3>
          <ul className="flex flex-col divide-y divide-border">
            {state.invitations.map((invitation) => (
              <li key={invitation.projectId} className="flex min-h-10 items-center justify-between gap-3 py-1">
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
      {state.loaded && state.entries.length === 0 ? <p className="text-sm text-muted-foreground">No projects yet.</p> : null}
      {active.length > 0 ? <ul className="flex flex-col divide-y divide-border">{active.map(row)}</ul> : null}
      {archived.length > 0 ? (
        <section aria-labelledby="archived-heading" className="flex flex-col gap-2">
          <h3 id="archived-heading" className="text-sm font-semibold text-muted-foreground">
            Archived
          </h3>
          <ul className="flex flex-col divide-y divide-border">{archived.map(row)}</ul>
        </section>
      ) : null}
      {membersOf ? (
        <MembersDialog
          library={library}
          projectId={membersOf.id}
          title={membersOf.title}
          owner={membersOf.role === "owner"}
          you={account.userId}
          onClose={() => setMembersOf(null)}
        />
      ) : null}
      {deleting ? (
        <DeleteProjectDialog
          title={deleting.entry.title}
          unsynced={deleting.unsynced}
          onDelete={() => deletePermanently(deleting.entry)}
          onClose={() => setDeleting(null)}
        />
      ) : null}
      <form onSubmit={create} className="flex items-end gap-2 border-t border-border pt-4">
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
