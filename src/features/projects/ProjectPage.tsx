import { Link, useLocation, useNavigate } from "@tanstack/react-router"
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react"
import { PanelPage } from "@/components/panel"
import { Banner, BannerAction, type MenuEntry } from "@/features/design-system"
import { parseProjectLocation, projectHref } from "@/features/navigation"
import { ProjectChanges } from "@/features/project-storage/changes"
import type { ConflictChoice } from "@/features/project-storage/sync"
import { canEdit } from "@/features/project-storage/model"
import { projectWorkspace } from "@/features/workbench/workspaceStore"
import { loadWorkbench } from "@/features/workbench/load"
import { projectHits, type SearchPassage } from "@/features/workbench/contentSearch"
import { createClient } from "@/lib/supabase/client"
import { fileStoreFor, libraryFor, openLocalProject, useLibraryState, type ProjectAccount } from "./account"
import { MembersDialog } from "./MembersDialog"
import { projectMenuEntries } from "./projectMenu"
import { readOnlyReason } from "./readOnly"
import { syncDot } from "./statusLabel"
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
          <Link to="/" className="text-(--accent-soft-text) underline underline-offset-4">
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

  // The files panel's search: the server's search in this project.
  const searchFiles = useCallback(
    async (query: string) => {
      const { data, error } = await createClient().functions.invoke<{ results: SearchPassage[] }>("search", {
        body: { query, matchCount: 30, projectId },
      })
      if (error) {
        if (error.name === "FunctionsFetchError") throw new Error("Search needs a connection.")
        // Over the searches a minute limit, the function answers 429 with a message that says when to try again.
        const limited = error.context instanceof Response && error.context.status === 429 ? await error.context.json().catch(() => null) : null
        throw new Error(typeof limited?.error === "string" ? limited.error : `Search failed: ${error.message}`)
      }
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
          <Link to="/" className="text-(--accent-soft-text) underline underline-offset-4">
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
  // The project menu starts with the other projects and the way home; the workbench adds the actions.
  const go = (href: string) => void navigate({ href })
  const projectMenu: MenuEntry[] = account.local
    ? [{ label: "Home", group: "home", onSelect: () => go("/") }]
    : projectMenuEntries(state.entries, projectId, go)
  const problem = departureError ?? error
  const notices = (
    <>
      {readOnly ? (
        <Banner
          tone={entry?.archived ? "warn" : "info"}
          action={entry?.archived && canEdit(entry.role) ? <BannerAction onClick={() => void unarchive()}>Unarchive</BannerAction> : undefined}
        >
          {readOnly}
        </Banner>
      ) : null}
      {problem ? <Banner tone="danger">{problem}</Banner> : null}
    </>
  )

  // The sync state sits with the person in the account panel.
  const sync = entry && !account.local ? syncDot(entry, !account.online || state.offline) : null

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
        projectName={account.local ? "Local project" : (entry?.title ?? "Project")}
        projectMenu={projectMenu}
        onShare={entry?.role === "owner" && account.online ? () => setSharing(true) : undefined}
        projectNotices={notices}
        sync={sync}
        onSyncNow={account.online && !account.local ? () => void syncNow() : undefined}
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
