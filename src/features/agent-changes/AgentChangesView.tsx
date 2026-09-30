import { Bot, ChevronDown, CircleAlert, X } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet"
import { personName } from "@/features/auth/accountName"
import { useProjectComments } from "@/features/comments"
import { AgentChangeRow, DiffBlock, EmptyState, LoadingLine, type AgentChangeAction } from "@/features/design-system"
import { LocalConflictError } from "@/features/project-storage/fileStore"
import { editorLanguageForPath, kindForPath } from "@/features/workbench/session"
import type { WorkspaceFileRef } from "@/features/workbench/workspaceStore"
import { cn } from "@/lib/utils"
import type { AgentChangesSurfaceProps } from "./AgentChangesSurface"
import type { AgentChange } from "./remote"
import type { ProjectAgentChanges } from "./store"

// The Agent changes view (AgentChangesSurface.tsx loads it): the versions
// agents saved in the project, newest first. The ones since the person last
// looked show first; Show earlier adds the rest, a page at a time. Opening
// it marks everything up to now seen.

/** Load at most this many pages looking for the change a link opened. */
const MAX_FOCUS_PAGES = 20

const keyOf = (change: Pick<AgentChange, "file_id" | "version">) => `${change.file_id}:${change.version}`

type Loaded = { changes: AgentChange[]; seen: number; more: boolean }

/** What the agent did to the file, from the version before it. */
function actionOf(change: AgentChange): AgentChangeAction {
  if (change.deleted) return "deleted"
  if (!change.previous || change.previous.deleted) return "created"
  if (change.previous.path !== change.path && change.previous.content === change.content) return "moved"
  return "changed"
}

/** The text Revert saves (null: Revert deletes the file), or undefined when there is nothing to revert. */
function revertContent(change: AgentChange): string | null | undefined {
  const before = change.previous && !change.previous.deleted ? change.previous.content : null
  if (!change.deleted && before === change.content) return undefined
  return before
}

/**
 * Why Revert cannot run now, or null. Revert saves over this device's copy
 * (`local`), so that copy must be the agent's version (none, when the agent
 * deleted the file): newer means the file changed again, even if the list
 * loaded before that; older means the agent's version has not synced here.
 */
function revertBlocked(change: AgentChange, local: WorkspaceFileRef | undefined, reverted: boolean): string | null {
  if (reverted) return "Reverted"
  const at = local?.server?.version
  if (!change.latest || (at !== undefined && at > change.version)) return "Changed again since"
  if (change.deleted ? at !== undefined : at !== change.version) return `This device has not synced version ${change.version} yet`
  if (local && (local.draft || local.unsynced || local.conflict)) return "Unsynced edits on this device"
  return null
}

/** Once the comments show `fileId`, open the thread in them. */
function openThreadOnceShown(controller: NonNullable<ReturnType<typeof useProjectComments>>["controller"], fileId: string, threadId: string) {
  const shown = () => controller.getState().target?.file?.fileId === fileId
  if (shown()) return controller.openThread(threadId)
  const stop = controller.subscribe(() => {
    if (!shown()) return
    stop()
    controller.openThread(threadId)
  })
  setTimeout(stop, 15_000)
}

export function AgentChangesView({
  store,
  compact,
  workspace,
  readOnly,
  onOpenFile,
}: AgentChangesSurfaceProps & { store: ProjectAgentChanges }) {
  const comments = useProjectComments()
  const [focus] = useState(() => store.getState().focus)
  const focusKey = focus ? `${focus.fileId}:${focus.version}` : null
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading")
  const [problem, setProblem] = useState<string | null>(null)
  const [earlier, setEarlier] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [files, setFiles] = useState<ReadonlyMap<string, WorkspaceFileRef>>(new Map())
  const [reverting, setReverting] = useState<string | null>(null)
  const [results, setResults] = useState<ReadonlyMap<string, { text: string; done: boolean }>>(new Map())
  const [attempt, setAttempt] = useState(0)
  const scrolled = useRef(false)

  // This device's copies, by the server's file id: where each file is now, and whether it has edits not synced yet.
  const refreshFiles = useCallback(async () => {
    const { files: listed } = await workspace.listEntries()
    setFiles(new Map(listed.flatMap((file) => (file.server ? [[file.server.id, file] as const] : []))))
    return listed
  }, [workspace])
  // Sync can bring a file's newer version while the view is open.
  useEffect(() => workspace.subscribe(() => void refreshFiles().catch(() => {})), [refreshFiles, workspace])

  useEffect(() => {
    let active = true
    const load = async () => {
      setStatus("loading")
      try {
        const listing = refreshFiles().catch(() => {})
        let page = await store.remote.list(store.projectId)
        const all = [...page.changes]
        // Opened at a change: load older pages until it is there.
        for (let pages = 1; focus && page.more && !all.some((change) => keyOf(change) === focusKey) && pages < MAX_FOCUS_PAGES; pages++) {
          page = await store.remote.list(store.projectId, all[all.length - 1].version)
          all.push(...page.changes)
        }
        // Revert's state needs this device's copies.
        await listing
        if (!active) return
        const first = all[0]
        const seen = page.seen
        setLoaded({ changes: all, seen, more: page.more })
        // The newest change starts open, and so does the one a link opened.
        const open = new Set<string>()
        if (first && first.version > seen) open.add(keyOf(first))
        if (focusKey) open.add(focusKey)
        setExpanded(open)
        if (focus && all.some((change) => keyOf(change) === focusKey && change.version <= seen)) setEarlier(true)
        setStatus("ready")
        // Looked at: up to now, nothing is new. The marker is only a hint, so a failure is let go.
        if (first && first.version > seen) {
          const revision = Math.max(...all.map((change) => change.version))
          void store.remote.markSeen(store.projectId, revision).then(() => store.markedSeen(), () => {})
        }
      } catch {
        if (active) setStatus("error")
      }
    }
    void load()
    return () => {
      active = false
    }
  }, [attempt, focus, focusKey, refreshFiles, store])

  // The change a link opened comes into view and takes the keyboard.
  useEffect(() => {
    if (!focus || status !== "ready" || scrolled.current) return
    scrolled.current = true
    requestAnimationFrame(() => {
      const row = document.querySelector<HTMLElement>(`[data-change-key="${focusKey}"]`)
      row?.scrollIntoView({ block: "start" })
      row?.focus({ preventScroll: true })
    })
  }, [focus, focusKey, status])

  const close = () => store.close()

  const showEarlier = async () => {
    if (!loaded) return
    if (!earlier) {
      setEarlier(true)
      if (loaded.changes.some((change) => change.version <= loaded.seen) || !loaded.more) return
    }
    setLoadingMore(true)
    setProblem(null)
    try {
      const page = await store.remote.list(store.projectId, loaded.changes[loaded.changes.length - 1].version)
      setLoaded({ ...loaded, changes: [...loaded.changes, ...page.changes], more: page.more })
    } catch {
      setProblem("Earlier changes did not load. Check your connection and try again.")
    } finally {
      setLoadingMore(false)
    }
  }

  const revert = async (change: AgentChange) => {
    const key = keyOf(change)
    const content = revertContent(change)
    if (content === undefined) return
    setReverting(key)
    const say = (text: string, done: boolean) => setResults((current) => new Map(current).set(key, { text, done }))
    try {
      const listed = await refreshFiles()
      const local = listed.find((file) => file.server?.id === change.file_id)
      const blocked = revertBlocked(change, local, false)
      if (blocked) return say(`Not reverted: ${blocked.toLowerCase()}.`, false)
      const before = change.previous?.version
      if (content === null) {
        // The agent created the file: reverting deletes it.
        if (!local?.revision) return say(`Not reverted: ${change.path} is not on this device.`, false)
        await workspace.save([{ kind: "delete", path: local.path, expectedRevision: local.revision }])
        say(`Reverted: ${local.path} is deleted, as it was before.`, true)
      } else if (local?.revision) {
        await workspace.write(local.path, { content, expectedRevision: local.revision })
        say(`Reverted: version ${before}'s text is saved as a new version.`, true)
      } else {
        // The agent deleted the file: it comes back where it was.
        const path = change.previous?.path ?? change.path
        if (listed.some((file) => file.path === path)) return say(`Not reverted: another file is at ${path} now.`, false)
        await workspace.write(path, { content, expectedRevision: null })
        say(`Reverted: ${path} is back, with version ${before}'s text.`, true)
      }
      await refreshFiles().catch(() => {})
    } catch (error) {
      say(
        error instanceof LocalConflictError
          ? `Not reverted: ${change.path} changed on this device just now. Try again.`
          : `Not reverted: ${error instanceof Error ? error.message : String(error)}`,
        false,
      )
    } finally {
      setReverting(null)
    }
  }

  const open = (path: string) => {
    close()
    onOpenFile(path)
  }

  const touch = compact
  const row = (change: AgentChange) => {
    const key = keyOf(change)
    const local = files.get(change.file_id)
    const kind = kindForPath(change.path)
    const action = actionOf(change)
    const result = results.get(key)
    const content = revertContent(change)
    const person = change.author ? (personName(change.author.name ?? null, change.author.email) ?? null) : null
    const isExpanded = expanded.has(key)
    const thread = change.thread
    let body
    if (kind === "drawing") {
      body = <p className="m-0 text-muted-foreground">Canvas changed. Open the drawing to see it.</p>
    } else if (action === "deleted") {
      body = <p className="m-0 text-muted-foreground">The file was deleted{change.previous ? `. Revert brings back version ${change.previous.version}.` : "."}</p>
    } else if (action === "moved") {
      body = <p className="m-0 text-muted-foreground">Moved from {change.previous?.path}. The text did not change.</p>
    } else {
      body = isExpanded ? (
        <DiffBlock
          before={change.previous && !change.previous.deleted ? (change.previous.content ?? "") : ""}
          after={change.content ?? ""}
          language={editorLanguageForPath(change.path)}
          beforeLabel={change.previous ? `Version ${change.previous.version}` : "Before"}
          afterLabel={`Version ${change.version}`}
          legend={
            change.previous
              ? `Lines marked − were in version ${change.previous.version}, and lines marked + are in version ${change.version}.`
              : `The agent created the file: every line is new in version ${change.version}.`
          }
          className="h-[min(50dvh,24rem)]"
        />
      ) : null
    }
    return (
      <li key={key}>
        <AgentChangeRow
          data-change-key={key}
          agent={change.agent}
          person={person}
          path={change.path}
          kind={kind}
          action={action}
          movedFrom={action === "moved" ? change.previous?.path : undefined}
          version={change.version}
          when={change.created_at}
          isNew={loaded !== null && change.version > loaded.seen}
          active={focusKey === key}
          size={touch ? "touch" : "default"}
          thread={
            thread
              ? {
                  opening: thread.opening,
                  onShow:
                    local && comments
                      ? () => {
                          open(local.path)
                          openThreadOnceShown(comments.controller, change.file_id, thread.id)
                        }
                      : undefined,
                }
              : null
          }
          expanded={isExpanded}
          onExpandedChange={(next) =>
            setExpanded((current) => {
              const changed = new Set(current)
              if (next) changed.add(key)
              else changed.delete(key)
              return changed
            })
          }
          onOpen={local ? () => open(local.path) : undefined}
          onRevert={readOnly || content === undefined ? undefined : () => void revert(change)}
          revertBlocked={revertBlocked(change, local, result?.done === true)}
          reverting={reverting === key}
          status={result?.text}
        >
          {body}
        </AgentChangeRow>
      </li>
    )
  }

  const fresh = loaded ? loaded.changes.filter((change) => change.version > loaded.seen) : []
  const older = loaded ? loaded.changes.filter((change) => change.version <= loaded.seen) : []
  const canShowEarlier = loaded !== null && (!earlier ? older.length > 0 || loaded.more : loaded.more)

  let content
  if (status === "loading" && !loaded) {
    content = null
  } else if (status === "error") {
    content = (
      <EmptyState
        icon={<CircleAlert />}
        title="Agent changes did not load"
        description="Check your connection and try again."
        actions={
          <Button variant="secondary" size={touch ? "touch" : "default"} onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </Button>
        }
        className="py-10"
      />
    )
  } else if (loaded) {
    const listClass = cn("m-0 flex list-none flex-col p-0", touch ? "gap-2.5" : "gap-2")
    content = (
      <>
        {fresh.length > 0 ? (
          <section aria-label="New since you last looked" className="flex flex-col gap-2">
            <h3 className="m-0 flex h-6 items-center gap-1.5 px-1 text-[11px] leading-none font-semibold tracking-[0.07em] text-dim uppercase">
              New since you last looked <span className="font-mono font-normal tracking-normal">{fresh.length}</span>
            </h3>
            <ul className={listClass}>{fresh.map(row)}</ul>
          </section>
        ) : (
          <EmptyState
            icon={<Bot />}
            title={loaded.changes.length === 0 && !loaded.more ? "No agent changes yet" : "Nothing new"}
            description={
              loaded.changes.length === 0 && !loaded.more
                ? "When an agent saves a file in this project, it shows here."
                : "No agent has saved a file here since you last looked."
            }
            className="py-8"
          />
        )}
        {earlier && older.length > 0 && (
          <section aria-label="Earlier" className="flex flex-col gap-2">
            <h3 className="m-0 flex h-6 items-center gap-1.5 px-1 text-[11px] leading-none font-semibold tracking-[0.07em] text-dim uppercase">Earlier</h3>
            <ul className={listClass}>{older.map(row)}</ul>
          </section>
        )}
        {problem && <p role="alert" className="m-0 px-1 text-xs text-destructive">{problem}</p>}
        {canShowEarlier && (
          <Button variant="ghost" size={touch ? "touch" : "sm"} className="self-start" disabled={loadingMore} onClick={() => void showEarlier()}>
            <ChevronDown data-icon="inline-start" aria-hidden="true" />
            {loadingMore ? "Loading…" : "Show earlier"}
          </Button>
        )}
      </>
    )
  }

  return (
    <Sheet open onOpenChange={(next) => !next && close()}>
      <SheetContent
        side={compact ? "bottom" : "right"}
        showCloseButton={false}
        className={cn(
          "gap-0 overflow-hidden border-border p-0 shadow-panel",
          compact
            ? "rounded-t-panel border-x data-[side=bottom]:h-[85svh]"
            : "data-[side=right]:w-[min(800px,100vw)] data-[side=right]:sm:max-w-none",
        )}
      >
        {compact && (
          <div aria-hidden="true" className="flex shrink-0 justify-center pt-2">
            <span className="h-1 w-9 rounded-pill bg-border" />
          </div>
        )}
        <div className={cn("flex shrink-0 items-center gap-2 border-b border-border", touch ? "h-14 pr-2.5 pl-4" : "h-12 pr-2 pl-3.5")}>
          <Bot aria-hidden="true" className={cn("shrink-0 text-muted-foreground", touch ? "size-5" : "size-4")} />
          <SheetTitle className={cn("leading-none font-semibold", touch ? "text-[17px]" : "text-sm")}>Agent changes</SheetTitle>
          <SheetClose
            render={<Button variant="ghost" size={touch ? "icon-lg" : "icon"} className="ml-auto" aria-label="Close agent changes" />}
          >
            <X aria-hidden="true" />
          </SheetClose>
        </div>
        <SheetDescription className="sr-only">The files agents saved in this project, newest first.</SheetDescription>
        {status === "loading" && <LoadingLine label="Loading agent changes" className="shrink-0" />}
        <ScrollArea className="min-h-0 flex-1">
          <div className={cn("flex flex-col", touch ? "gap-4 p-3 pb-6 text-[15px]" : "gap-3.5 p-3 text-[13px]")}>{content}</div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}
