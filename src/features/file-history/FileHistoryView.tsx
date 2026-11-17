import { useEffect, useMemo, useState } from "react"
import { History, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet"
import { Banner, DiffBlock, LoadingLine } from "@/features/design-system"
import { loadClient } from "@/lib/supabase/client"
import { cn } from "@/lib/utils"
import { ImageVersions } from "../images/ImageVersions"
import { byteLength } from "../project-storage/model"
import { editorLanguageForPath } from "../workbench/session"
import type { WorkspaceFileRef } from "../workbench/workspaceStore"
import type { FileHistoryViewProps } from "./context"
import { formatHistoryDay, formatHistoryTimestamp, groupVersions, historyAuthorName, HISTORY_TIME_ZONE } from "./grouping"
import { SupabaseFileHistoryRemote, type FileHistoryAuthor, type FileHistoryPage, type FileHistoryRemote, type FileVersion, type FileVersionContent } from "./remote"
import { restoreBlocked, restoreVersion } from "./restore"

const DIFF_LIMIT = 1024 * 1024
type Contents = (version: FileVersion) => Promise<FileVersionContent>

/** Each comparison loads independently, only while expanded. */
function Comparison({ remote, projectId, fileId, first, after, contents }: {
  remote: FileHistoryRemote; projectId: string; fileId: string; first: FileVersion; after: FileVersion; contents: Contents
}) {
  const [loaded, setLoaded] = useState<{ before: FileVersionContent | null; after: FileVersionContent } | null>(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        // Revision order defines the before state, even when transaction timestamps cross midnight out of order.
        const [before, end] = await Promise.all([
          remote.predecessor(projectId, fileId, first.version).then(row => row ? contents(row) : null),
          contents(after),
        ])
        if (active) { setLoaded({ before, after: end }); setFailed(false) }
      } catch { if (active) setFailed(true) }
    }
    void load()
    return () => { active = false }
  }, [remote, projectId, fileId, first.version, after, contents, attempt])
  if (failed) return <p role="alert">The comparison did not load. <Button variant="inline" size="inline" onClick={() => { setFailed(false); setAttempt(value => value + 1) }}>Try again</Button></p>
  if (!loaded) return <LoadingLine label="Loading the changes" />
  const { before, after: end } = loaded
  const beforeText = before?.content ?? ""
  const afterText = end.content ?? ""
  return <div className="flex flex-col gap-2">
    <p className="m-0 text-xs text-muted-foreground">{before ? `Before: version ${before.version} at ${before.path}` : "Before: the file did not exist"}. After: version {end.version} at {end.path}{end.deleted ? " (deleted)" : ""}.</p>
    {before?.kind === "image" || end.kind === "image"
      ? <ImageVersions projectId={projectId} before={before?.deleted ? null : before?.asset ?? null} after={end.deleted ? null : end.asset} />
      : byteLength(beforeText) + byteLength(afterText) > DIFF_LIMIT
        ? <p className="m-0 text-muted-foreground">Too large to compare here. You can still restore an individual save.</p>
        : <DiffBlock before={beforeText} after={afterText} language={editorLanguageForPath(end.path)}
          beforeLabel={before ? `Version ${before.version}` : "Before creation"} afterLabel={`Version ${end.version}`}
          className="h-[min(45dvh,24rem)]" />}
  </div>
}

export function FileHistoryView({ workspace, projectId, path, compact, readOnly, isDirty, onClose }: FileHistoryViewProps) {
  const [remote, setRemote] = useState<FileHistoryRemote | null>(null)
  const [page, setPage] = useState<FileHistoryPage | null>(null)
  const [baseline, setBaseline] = useState<WorkspaceFileRef | null>(null)
  const [current, setCurrent] = useState<WorkspaceFileRef | undefined>()
  const [authors, setAuthors] = useState<FileHistoryAuthor[]>([])
  const [authorsFailed, setAuthorsFailed] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading")
  const [attempt, setAttempt] = useState(0)
  const [expandedDays, setExpandedDays] = useState<ReadonlySet<string>>(new Set())
  const [expandedSaves, setExpandedSaves] = useState<ReadonlySet<number>>(new Set())
  const [loadingMore, setLoadingMore] = useState(false)
  const [restoring, setRestoring] = useState<number | null>(null)
  const [results, setResults] = useState<ReadonlyMap<number, string>>(new Map())
  const [restored, setRestored] = useState(false)
  const fileId = baseline?.server?.id
  const contents = useMemo<Contents>(() => {
    const cache = new Map<number, Promise<FileVersionContent>>()
    return version => {
      if (!remote || version.file_id !== fileId) return Promise.reject(new Error("History is not ready for this file."))
      let pending = cache.get(version.version)
      if (!pending) {
        pending = remote.content(projectId, fileId, version.version).catch(error => { cache.delete(version.version); throw error })
        cache.set(version.version, pending)
      }
      return pending
    }
  }, [remote, projectId, fileId])

  useEffect(() => {
    let active = true
    const load = async () => {
      setStatus("loading"); setProblem(null)
      try {
        const [{ files }, client] = await Promise.all([workspace.listEntries(), loadClient()])
        const file = files.find(row => row.path === path)
        if (!active) return
        setBaseline(file ?? null); setCurrent(file)
        if (!file?.server) { setStatus("ready"); return }
        const service = new SupabaseFileHistoryRemote(client)
        setRemote(service)
        // Authors never hold up the requested history.
        void service.authors(projectId).then(value => { if (active) { setAuthors(value); setAuthorsFailed(false) } }, () => { if (active) setAuthorsFailed(true) })
        const listing = await service.list(projectId, file.server.id)
        if (!active) return
        setPage(listing)
        setExpandedDays(new Set(groupVersions(listing.versions, listing.previous).slice(0, 1).map(day => day.day)))
        setStatus("ready")
      } catch { if (active) setStatus("error") }
    }
    void load()
    return () => { active = false }
  }, [workspace, projectId, path, attempt])

  useEffect(() => {
    if (!baseline?.server) return
    let active = true
    const refresh = async () => {
      try {
        const { files } = await workspace.listEntries()
        if (active) setCurrent(files.find(file => file.server?.id === baseline.server?.id))
      } catch { /* A failed refresh cannot authorize a restore; restore rechecks before saving. */ }
    }
    const stop = workspace.subscribe(() => void refresh())
    void refresh()
    return () => { active = false; stop() }
  }, [workspace, baseline])

  const days = page ? groupVersions(page.versions, page.previous) : []
  const latest = page?.versions.reduce((version, row) => Math.max(version, row.version), 0)
  const baselineVersion = page?.versions.find(version => version.version === baseline?.server?.version) ?? page?.versions[0]
  let blocked = baselineVersion ? restoreBlocked(current, baselineVersion, readOnly, isDirty(current?.path ?? path)) : "This file has not synced yet."
  if (!blocked && baseline && (baseline.revision !== current?.revision || baseline.server?.version !== current?.server?.version || baseline.path !== current?.path)) blocked = "This file changed since history loaded. Close and reopen history before restoring."
  if (!blocked && (baseline?.server?.version ?? 0) < (latest ?? 0)) blocked = "Sync the latest version before restoring."
  if (restored) blocked = "Restored. Close and reopen history to see the new save after sync."

  const showEarlier = async () => {
    if (!remote || !baseline?.server || !page || days.length === 0) return
    setLoadingMore(true); setProblem(null)
    try {
      const earlier = await remote.list(projectId, baseline.server.id, days.at(-1)!.day)
      setPage({ ...earlier, versions: [...page.versions, ...earlier.versions] })
    } catch { setProblem("Earlier saves did not load. Check your connection and try again.") }
    finally { setLoadingMore(false) }
  }
  const restore = async (version: FileVersion) => {
    if (!baseline || blocked || restoring !== null || readOnly) return
    setRestoring(version.version)
    try {
      const value = await contents(version)
      await restoreVersion({ workspace, projectId, file: baseline, version, content: value.content, readOnly, isDirty })
      setResults(values => new Map(values).set(version.version, `Version ${version.version} saved on this device as a new save. Sync checks the server revision.`))
      setRestored(true)
    } catch (error) { setResults(values => new Map(values).set(version.version, `Not restored: ${error instanceof Error ? error.message : String(error)}`)) }
    finally { setRestoring(null) }
  }
  const toggle = <T,>(values: ReadonlySet<T>, value: T, open: boolean) => {
    const next = new Set(values)
    if (open) next.add(value); else next.delete(value)
    return next
  }

  return <Sheet open onOpenChange={open => { if (!open) onClose() }}>
    <SheetContent side={compact ? "bottom" : "right"} showCloseButton={false}
      className={cn("gap-0 overflow-hidden border-border p-0 shadow-panel", compact ? "rounded-t-panel data-[side=bottom]:h-[90svh]" : "data-[side=right]:w-[min(800px,100vw)] data-[side=right]:sm:max-w-none")}>
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
        <History className="size-4 text-muted-foreground" aria-hidden="true" />
        <SheetTitle className="text-sm">Version history</SheetTitle>
        <SheetClose render={<Button variant="ghost" size="icon" className="ml-auto" aria-label="Close version history" />}><X aria-hidden="true" /></SheetClose>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
        <SheetDescription className="mb-3 break-all">{current?.path ?? path}. Days and timestamps use {HISTORY_TIME_ZONE}. Every underlying save is kept.</SheetDescription>
        <p className="mb-3 text-xs text-muted-foreground">Restore copies a save’s content to the current path as a new revision-checked save. For D2, it restores the source and regenerates the canvas with the current layout.</p>
        {status === "loading" && <LoadingLine label="Loading version history" />}
        {status === "error" && <Banner tone="danger">Version history needs a connection and project access. <Button variant="inline" size="inline" onClick={() => setAttempt(value => value + 1)}>Try again</Button></Banner>}
        {status === "ready" && !baseline?.server && <p>Save and sync this file to start its version history.</p>}
        {status === "ready" && page?.versions.length === 0 && <p>No saved versions are available.</p>}
        {authorsFailed && <p className="mb-3 text-xs text-muted-foreground">Author names did not load. Saves show account IDs where available.</p>}
        {blocked && !readOnly && baseline?.server && <p className="mb-3 text-xs text-muted-foreground">{blocked}</p>}
        <div className="flex flex-col gap-3">
          {remote && baseline?.server && days.map(day => <details key={day.day} open={expandedDays.has(day.day)}
            onToggle={event => { const open = event.currentTarget.open; setExpandedDays(values => toggle(values, day.day, open)) }}
            className="rounded-panel border border-border">
            <summary className="cursor-pointer rounded-panel px-3 py-3 font-semibold focus-visible:outline-2 focus-visible:outline-ring">{formatHistoryDay(day.day)} · {day.versions.length} {day.versions.length === 1 ? "save" : "saves"}</summary>
            {expandedDays.has(day.day) && <div className="flex flex-col gap-4 px-3 pb-3">
              <h3 className="m-0 text-xs font-semibold text-muted-foreground">Combined changes for this day</h3>
              <Comparison remote={remote} projectId={projectId} fileId={baseline.server!.id} first={day.versions.at(-1)!} after={day.after} contents={contents} />
              <div className="flex flex-col gap-2" aria-label={`Individual saves on ${formatHistoryDay(day.day)}`}>
                {day.versions.map(version => <details key={version.version} open={expandedSaves.has(version.version)}
                  onToggle={event => { const open = event.currentTarget.open; setExpandedSaves(values => toggle(values, version.version, open)) }}
                  className="rounded-tool border border-border">
                  <summary className="cursor-pointer px-3 py-2 focus-visible:outline-2 focus-visible:outline-ring">
                    <span className="font-semibold">Version {version.version}</span> · {historyAuthorName(version.author_id, authors)} · <time dateTime={version.created_at}>{formatHistoryTimestamp(version.created_at)}</time>
                  </summary>
                  {expandedSaves.has(version.version) && <div className="flex flex-col gap-3 px-3 pb-3">
                    <p className="m-0 break-all text-xs text-muted-foreground">Saved at {version.path}{version.deleted ? " (deleted)" : ""}</p>
                    <Comparison remote={remote} projectId={projectId} fileId={baseline.server!.id} first={version} after={version} contents={contents} />
                    {!readOnly && !version.deleted && <Button variant="secondary" className="self-start" size={compact ? "touch" : "sm"}
                      disabled={Boolean(blocked) || Boolean(restoreBlocked(current, version, readOnly, isDirty(current?.path ?? path))) || restoring !== null || version.version === baseline.server!.version}
                      onClick={() => void restore(version)}>{restoring === version.version ? "Restoring…" : `Restore version ${version.version}`}</Button>}
                    {version.deleted && <p className="m-0 text-xs text-muted-foreground">This save records a deletion. Expand an earlier save to restore its content.</p>}
                    {version.version === baseline.server!.version && <p className="m-0 text-xs text-muted-foreground">Current saved version</p>}
                    {results.has(version.version) && <p role="status" className="m-0 text-xs">{results.get(version.version)}</p>}
                  </div>}
                </details>)}
              </div>
            </div>}
          </details>)}
        </div>
        {problem && <p role="alert" className="mt-3">{problem}</p>}
        {page?.more && <Button variant="ghost" className="mt-3" disabled={loadingMore} onClick={() => void showEarlier()}>{loadingMore ? "Loading…" : "Show earlier"}</Button>}
      </div>
    </SheetContent>
  </Sheet>
}
