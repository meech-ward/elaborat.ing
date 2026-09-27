import { Link, useLocation, useNavigate } from "@tanstack/react-router"
import { UserPlus } from "lucide-react"
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react"
import { PanelPage } from "@/components/panel"
import { Button } from "@/components/ui/button"
import { parseProjectLocation, projectHref } from "@/features/navigation"
import { ProjectChanges } from "@/features/project-storage/changes"
import type { ConflictChoice } from "@/features/project-storage/sync"
import { canEdit } from "@/features/project-storage/model"
import { projectWorkspace } from "@/features/workbench/workspaceStore"
import { loadWorkbench } from "@/features/workbench/load"
import { projectHits, type SearchPassage } from "@/features/workbench/contentSearch"
import { createClient } from "@/lib/supabase/client"
import { fileStoreFor, libraryFor, openLocalProject, useLibraryState, type ProjectAccount } from "./account"
import { LocalProjectHeader } from "./LocalProject"
import { MembersDialog } from "./MembersDialog"
import { ProjectSwitcher } from "./ProjectSwitcher"
import { readOnlyReason } from "./readOnly"
import { statusLabel } from "./statusLabel"
import { useBackgroundRefresh } from "./useBackgroundRefresh"
import { useDepartureGuard } from "./useDepartureGuard"

// The editor loads in its own chunk (see features/workbench/load.ts).
const WorkspaceWorkbench = lazy(() => loadWorkbench().then((module) => ({ default: module.WorkspaceWorkbench })))

/** Wait this long after a save before syncing, so a burst of saves is sent together. */
const SYNC_DELAY_MS = 1_000

/**
 * One project at its URL: downloaded on first open, kept in sync, and edited
 * in the workbench. A file's URL opens it.
 */
export function ProjectPage({ account }: { account: ProjectAccount }) {
  const href = useLocation({ select: (location) => location.href })
  const location = parseProjectLocation(href)
  if (location.kind === "invalid") {
    return (
      <PanelPage>
        <p role="alert">
          {location.message}{" "}
          <Link to="/" className="text-(--link) underline underline-offset-4">
            Go to your projects
          </Link>
          .
        </p>
      </PanelPage>
    )
  }
  return <OpenProject key={location.projectId} account={account} projectId={location.projectId} />
}

function OpenProject({ account, projectId }: { account: ProjectAccount; projectId: string }) {
  const library = libraryFor(account)
  const state = useLibraryState(library)
  const navigate = useNavigate()
  const [opened, setOpened] = useState<"opening" | "open" | "missing">("opening")
  const [error, setError] = useState<string | null>(null)
  const [sharing, setSharing] = useState(false)
  const onError = useCallback((message: string) => setError(message), [])
  useBackgroundRefresh(library, onError)
  const { registerLeaveGuard, departureError } = useDepartureGuard(projectId, opened === "open")
  const entry = state.entries.find((candidate) => candidate.id === projectId)

  const syncNow = useCallback(async () => {
    setError(null)
    try {
      const outcome = await library.syncProject(projectId)
      if (outcome.projectId !== projectId) {
        await navigate({ href: projectHref(outcome.projectId), replace: true, ignoreBlocker: true })
      } else if (outcome.status === "stopped" || outcome.status === "incomplete") {
        setError(outcome.message)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [library, navigate, projectId])

  // Download on first open, then sync.
  useEffect(() => {
    let active = true
    const opening = account.local ? openLocalProject() : library.open(projectId)
    opening
      .then((found) => {
        if (!active) return
        setOpened(found ? "open" : "missing")
        if (found && account.online) void syncNow()
      })
      .catch((cause: unknown) => active && setError(cause instanceof Error ? cause.message : String(cause)))
    return () => {
      active = false
    }
  }, [account.local, account.online, library, projectId, syncNow])

  // Hear about changes made elsewhere while the project is open.
  useEffect(() => {
    if (!account.online || opened !== "open") return
    const changes = new ProjectChanges(createClient(), projectId, 0, () => void syncNow())
    return () => {
      void changes.close()
    }
  }, [account.online, opened, projectId, syncNow])

  // Saves sync shortly after they happen, a burst of them together.
  const [delayedSync] = useState(() => new Delayed(SYNC_DELAY_MS))
  useEffect(() => () => delayedSync.cancel(), [delayedSync])
  const workspace = useMemo(
    () =>
      projectWorkspace(fileStoreFor(library, projectId), {
        afterSave: () => {
          if (account.online) delayedSync.run(() => void syncNow())
        },
        subscribeSync: (listener) => library.subscribe(listener),
      }),
    [account.online, delayedSync, library, projectId, syncNow],
  )

  // The files panel's search: the server's search over every project the
  // person can read, narrowed to this one.
  const searchFiles = useCallback(
    async (query: string) => {
      const { data, error } = await createClient().functions.invoke<{ results: SearchPassage[] }>("search", { body: { query, matchCount: 30 } })
      if (error) throw new Error(error.name === "FunctionsFetchError" ? "Search needs a connection." : `Search failed: ${error.message}`)
      return projectHits(data?.results ?? [], projectId)
    },
    [projectId],
  )

  const unarchive = useCallback(async () => {
    setError(null)
    try {
      await library.unarchive(projectId)
    } catch (cause) {
      setError(`Not unarchived: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }, [library, projectId])

  const resolveConflict = useCallback(
    async (path: string, choice: ConflictChoice) => {
      await library.sync.resolve(projectId, path, choice)
      if (account.online) await syncNow()
    },
    [account.online, library, projectId, syncNow],
  )

  if (opened === "missing") {
    return (
      <PanelPage>
        <h1 className="text-[21px] leading-tight font-semibold">Project not found</h1>
        <p>
          This project is not on this device, and {account.online ? "you do not have access to it on the server" : "you are offline"}.{" "}
          <Link to="/" className="text-(--link) underline underline-offset-4">
            Go to your projects
          </Link>
          .
        </p>
      </PanelPage>
    )
  }
  if (opened === "opening") {
    return (
      <PanelPage>
        <p role="status" className="text-[13px] text-muted-foreground">
          Opening project...
        </p>
      </PanelPage>
    )
  }

  const readOnly = readOnlyReason(entry)
  const header = account.local ? <LocalProjectHeader error={departureError ?? error} /> : (
    <div className="flex min-w-0 items-center gap-3 text-sm">
      <Link to="/" className="underline underline-offset-4">
        Your projects
      </Link>
      <h1 className="truncate font-semibold">{entry?.title ?? "Project"}</h1>
      <ProjectSwitcher entries={state.entries} current={projectId} />
      {entry?.role === "owner" && account.online ? (
        <button type="button" className="wb-icon wb-share-project" aria-label="Share project" title="Share project" onClick={() => setSharing(true)}>
          <UserPlus size={15} aria-hidden="true" />
        </button>
      ) : null}
      {readOnly ? <p className="text-(--amber)">{readOnly}</p> : null}
      {entry?.archived && canEdit(entry.role) ? (
        <Button variant="outline" size="sm" onClick={() => void unarchive()}>
          Unarchive
        </Button>
      ) : null}
      {error || departureError ? (
        <p role="alert" className="text-destructive">
          {departureError ?? error}
        </p>
      ) : null}
    </div>
  )

  // The sync state sits with the account on a desktop, and in the phone menu.
  const syncStatus = account.local ? (
    <p role="status" className="text-sm text-muted-foreground">
      Saved in this browser
    </p>
  ) : (
    <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
      <p role="status" className="truncate text-muted-foreground">
        {entry ? statusLabel(entry) : ""}
        {!account.online || state.offline ? " (offline)" : ""}
      </p>
      {account.online ? (
        <Button variant="outline" size="sm" onClick={() => void syncNow()}>
          Sync now
        </Button>
      ) : null}
    </div>
  )

  return (
    <Suspense
      fallback={
        <PanelPage>
          <p role="status" className="text-[13px] text-muted-foreground">
            Loading the editor...
          </p>
        </PanelPage>
      }
    >
      <WorkspaceWorkbench
        client={workspace}
        projectId={projectId}
        projectHeader={header}
        syncStatus={syncStatus}
        searchFiles={account.online && !account.local ? searchFiles : null}
        onLeaveGuard={registerLeaveGuard}
        onResolveConflict={resolveConflict}
        readOnly={readOnly}
        local={account.local}
      />
      {sharing && entry ? (
        <MembersDialog library={library} projectId={projectId} title={entry.title} owner={entry.role === "owner"} you={account.userId} onClose={() => setSharing(false)} />
      ) : null}
    </Suspense>
  )
}

/** Runs the latest scheduled work once, `ms` after the last request. */
class Delayed {
  private timer: ReturnType<typeof setTimeout> | undefined
  constructor(private readonly ms: number) {}
  run(work: () => void) {
    clearTimeout(this.timer)
    this.timer = setTimeout(work, this.ms)
  }
  cancel() {
    clearTimeout(this.timer)
  }
}
