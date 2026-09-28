import { Link, useNavigate } from "@tanstack/react-router"
import { Ellipsis } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { ActionMenu, Banner, BannerAction, FloatingPanel, NewProjectCard, ProjectCard, ProjectGrid, StatusDot, type MenuEntry } from "@/features/design-system"
import { projectHref } from "@/features/navigation"
import type { Invitation, ProjectEntry } from "@/features/project-storage/library"
import { canEdit } from "@/features/project-storage/model"
import { libraryFor, moveLocalProjectTo, useLibraryState, type ProjectAccount } from "./account"
import { DeletedProjectBanner } from "./DeletedProject"
import { DeleteProjectDialog } from "./DeleteProjectDialog"
import { useProjectDownload } from "./DownloadProject"
import { ImportProjectButton, ImportReport, useProjectImport } from "./ImportProject"
import { MembersDialog } from "./MembersDialog"
import { statusLabel, syncDot } from "./statusLabel"
import { useBackgroundRefresh } from "./useBackgroundRefresh"

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * A project's menu, by role: everyone sees its members and downloads it,
 * owners and editors archive and unarchive, the owner deletes permanently,
 * and anyone else can leave.
 */
function ProjectMenu({ entry, onMembers, onDownload, onArchive, onDelete, onLeave }: {
  entry: ProjectEntry
  onMembers: () => void
  onDownload: () => void
  /** Archive, or unarchive an archived project. */
  onArchive: () => void
  onDelete: () => void
  onLeave: () => void
}) {
  const items: MenuEntry[] = [
    { label: "Members", onSelect: onMembers },
    { label: "Download project", onSelect: onDownload },
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

/** The account's projects as cards, its invitations, and ways to start a new one or import one. */
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
  const importing = useProjectImport(library)
  const onError = useCallback((text: string) => setError(text), [])
  const download = useProjectDownload(library, onError, setNotice)
  useBackgroundRefresh(library, onError, { invitations: true })

  // Just signed in with work in the local project: it joins the account's projects and opens (the project page uploads it).
  useEffect(() => {
    if (!account.online) return
    let active = true
    moveLocalProjectTo(library, () => import("./welcomeNote"))
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

  const offline = !account.online || state.offline
  const active = state.entries.filter((entry) => !entry.archived)
  const archived = state.entries.filter((entry) => entry.archived)
  const card = (entry: ProjectEntry) => (
    <ProjectCard
      key={entry.id}
      title={entry.title}
      link={<Link to={projectHref(entry.id)} />}
      meta={
        <StatusDot status={syncDot(entry, offline).status}>{statusLabel(entry)}</StatusDot>
      }
      actions={
        entry.role !== null ? (
          <ProjectMenu
            entry={entry}
            onMembers={() => {
              setError(null)
              setNotice(null)
              setMembersOf(entry)
            }}
            onDownload={() => {
              setError(null)
              setNotice(null)
              void download.start(entry.id, entry.title)
            }}
            onArchive={() => void setArchived(entry)}
            onDelete={() => void askToDelete(entry)}
            onLeave={() => void leave(entry)}
          />
        ) : null
      }
    />
  )

  return (
    <section aria-labelledby="projects-heading" className="mx-auto flex w-full max-w-[880px] flex-col gap-6 px-3 pt-4 pb-16 sm:px-6 sm:pt-8">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="flex flex-col gap-1">
          <h1 id="projects-heading" className="text-[28px] leading-tight font-bold tracking-[-0.01em] sm:text-[32px]">
            Your projects
          </h1>
          {state.loaded && state.entries.length === 0 ? <p className="text-[15px] text-muted-foreground">No projects yet.</p> : null}
        </div>
        <ImportProjectButton state={importing.state} onChoose={(input, source) => void importing.choose(input, source)} />
      </div>
      {offline || error || notice || importing.state.kind !== "idle" || state.deleted.length > 0 ? (
        <div className="flex flex-col gap-2">
          {offline ? <Banner tone="info">Offline: showing the projects on this device. Changes sync when you are back online.</Banner> : null}
          {state.deleted.map((project) => (
            <DeletedProjectBanner key={project.id} library={library} project={project} onError={onError} />
          ))}
          {error ? <Banner tone="danger">{error}</Banner> : null}
          {notice ? (
            <Banner tone="info" action={<BannerAction onClick={() => setNotice(null)}>Dismiss</BannerAction>}>
              {notice}
            </Banner>
          ) : null}
          <ImportReport state={importing.state} />
        </div>
      ) : null}
      {state.invitations.length > 0 ? (
        <FloatingPanel render={<section aria-labelledby="invitations-heading" />} className="flex flex-col gap-1 p-4">
          <h2 id="invitations-heading" className="text-[11px] font-semibold tracking-[0.07em] text-dim uppercase">
            Invitations
          </h2>
          <ul className="flex flex-col divide-y divide-border">
            {state.invitations.map((invitation) => (
              <li key={invitation.projectId} className="flex min-h-11 items-center justify-between gap-3 py-1.5">
                <span className="min-w-0 text-[15px] [overflow-wrap:anywhere]">
                  <span className="font-semibold">{invitation.title}</span>
                  <span className="text-muted-foreground">, as {invitation.role}</span>
                </span>
                <Button aria-label={`Accept the invitation to ${invitation.title}`} onClick={() => void accept(invitation)}>
                  Accept
                </Button>
              </li>
            ))}
          </ul>
        </FloatingPanel>
      ) : null}
      <ProjectGrid aria-labelledby="projects-heading">
        <NewProjectCard id="new-project-title" value={title} onValueChange={setTitle} onSubmit={(event) => void create(event)} />
        {active.map(card)}
      </ProjectGrid>
      {archived.length > 0 ? (
        <section aria-labelledby="archived-heading" className="flex flex-col gap-3">
          <h2 id="archived-heading" className="text-[11px] font-semibold tracking-[0.07em] text-dim uppercase">
            Archived
          </h2>
          <ProjectGrid aria-labelledby="archived-heading">{archived.map(card)}</ProjectGrid>
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
      {download.dialog}
      {deleting ? (
        <DeleteProjectDialog
          title={deleting.entry.title}
          unsynced={deleting.unsynced}
          onDelete={() => deletePermanently(deleting.entry)}
          onClose={() => setDeleting(null)}
        />
      ) : null}
    </section>
  )
}
