import { Link } from "@tanstack/react-router"
import { FileUp } from "lucide-react"
import { useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { ActionMenu, Banner, type MenuEntry } from "@/features/design-system"
import type { ProjectLibrary } from "@/features/project-storage/library"
import { projectHref } from "@/features/navigation"
import { fileStoreFor } from "./account"
import type { ImportPlan } from "./prototypeImport"

// The archive code (with fflate) and the prototype's reader load on the first import.
const loadArchive = () => import("./projectArchive")
const loadPrototype = () => import("./prototypeImport")

export type ImportState =
  | { kind: "idle" }
  | { kind: "importing"; name: string }
  | { kind: "failed"; message: string }
  | { kind: "done"; projectId: string; title: string; files: number; folders: number; skipped: ImportPlan["skipped"] }

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** The largest .zip read: its files are unpacked in memory, and a project holds at most 64 MiB of text. */
const MAX_ZIP_BYTES = 256 * 1024 * 1024

/** What to import from: a project's .zip, a folder, or the prototype's .json export. */
export type ImportSource = "zip" | "folder" | "prototype"

/** Plan an import from what was chosen, or say why it cannot be imported. */
async function planFrom(source: ImportSource, files: File[]): Promise<{ ok: true; plan: ImportPlan } | { ok: false; error: string }> {
  const { folderEntries, planArchive, titleFrom, unzipFiles, zipEntries } = await loadArchive()
  if (source === "folder") {
    const folder = folderEntries(files)
    const read = async (paths: string[]) => {
      const found = new Map<string, Uint8Array>()
      for (const path of paths) {
        const file = folder.byPath.get(path)
        if (file) found.set(path, new Uint8Array(await file.arrayBuffer()))
      }
      return found
    }
    return planArchive(titleFrom(folder.name), folder.entries, read)
  }
  const file = files[0]
  if (source === "prototype") {
    const { planImport, readPrototypeExport } = await loadPrototype()
    const read = readPrototypeExport(await file.text())
    return read.ok ? { ok: true, plan: planImport(read.value) } : read
  }
  if (file.size > MAX_ZIP_BYTES) return { ok: false, error: "The .zip is larger than 256 MiB." }
  const zip = new Uint8Array(await file.arrayBuffer())
  let entries
  try {
    entries = zipEntries(zip)
  } catch {
    return { ok: false, error: "This file is not a .zip archive, or it is damaged." }
  }
  return planArchive(titleFrom(file.name), entries, async (paths) => unzipFiles(zip, new Set(paths)))
}

/**
 * Importing a project: from a .zip (such as one this app downloaded), a
 * folder, or the prototype's .json export. The state, and `choose` for the
 * file fields. Something that fails the checks creates nothing; paths this
 * app cannot store are skipped and listed with the reason for each.
 */
export function useProjectImport(library: ProjectLibrary) {
  const [state, setState] = useState<ImportState>({ kind: "idle" })

  const choose = async (input: HTMLInputElement, source: ImportSource) => {
    const files = [...(input.files ?? [])]
    // Let the same file be chosen again.
    input.value = ""
    if (files.length === 0) return
    try {
      const { folderEntries, titleFrom } = await loadArchive()
      const name = source === "folder" ? titleFrom(folderEntries(files).name) : files[0].name
      setState({ kind: "importing", name })
      const { importPrototype } = await loadPrototype()
      const planned = await planFrom(source, files)
      if (!planned.ok) {
        setState({ kind: "failed", message: `${name} could not be imported. ${planned.error}` })
        return
      }
      const { plan } = planned
      const projectId = await importPrototype(library, (id) => fileStoreFor(library, id), plan)
      void library.syncProject(projectId)
      setState({
        kind: "done",
        projectId,
        title: plan.title,
        files: plan.saves.reduce((sum, save) => sum + save.length, 0),
        folders: plan.directories.length,
        skipped: plan.skipped,
      })
    } catch (cause) {
      setState({ kind: "failed", message: `The import stopped: ${cause instanceof Error ? cause.message : String(cause)}` })
    }
  }
  return { state, choose }
}

/** Whether this browser can pick a whole folder. */
const folderPicking = () => typeof HTMLInputElement !== "undefined" && "webkitdirectory" in HTMLInputElement.prototype

/**
 * Import a project, as a quiet ghost button with a menu: a .zip, a folder
 * (where the browser can pick one), or the prototype's export. Each opens
 * its own hidden file field.
 */
export function ImportProjectButton({ state, onChoose }: { state: ImportState; onChoose: (input: HTMLInputElement, source: ImportSource) => void }) {
  const zip = useRef<HTMLInputElement>(null)
  const folder = useRef<HTMLInputElement>(null)
  const prototype = useRef<HTMLInputElement>(null)
  const busy = state.kind === "importing"
  const entries: MenuEntry[] = [
    { label: "A .zip file", onSelect: () => zip.current?.click() },
    ...(folderPicking() ? [{ label: "A folder", onSelect: () => folder.current?.click() }] : []),
    { label: "A prototype export (.json)", onSelect: () => prototype.current?.click() },
  ]
  const field = (ref: React.RefObject<HTMLInputElement | null>, label: string, source: ImportSource, props: React.InputHTMLAttributes<HTMLInputElement>) => (
    <input
      ref={ref}
      type="file"
      aria-label={label}
      tabIndex={-1}
      disabled={busy}
      onChange={(event) => onChoose(event.currentTarget, source)}
      className="sr-only"
      {...props}
    />
  )
  return (
    <span className="flex">
      {field(zip, "Import a .zip file", "zip", { accept: ".zip,application/zip" })}
      {field(folder, "Import a folder", "folder", { webkitdirectory: "", multiple: true } as React.InputHTMLAttributes<HTMLInputElement>)}
      {field(prototype, "Import a prototype export", "prototype", { accept: ".json,application/json" })}
      <ActionMenu
        entries={entries}
        trigger={
          <Button variant="ghost" disabled={busy}>
            <FileUp aria-hidden="true" />
            Import a folder or .zip
          </Button>
        }
        contentProps={{ align: "end" }}
      />
    </span>
  )
}

/** The most skipped paths listed; a folder with, say, a .git folder skips thousands. */
const SKIPPED_SHOWN = 100

/** How the import is going: under way, failed, or what it made and what it skipped. */
export function ImportReport({ state }: { state: ImportState }) {
  if (state.kind === "importing") return <Banner tone="info">Importing {state.name}…</Banner>
  if (state.kind === "failed") {
    return (
      <Banner tone="danger" className="[overflow-wrap:anywhere]">
        {state.message}
      </Banner>
    )
  }
  if (state.kind !== "done") return null
  return (
    <Banner tone="info">
      <span className="grid gap-2">
        <span>
          Imported{" "}
          <Link to={projectHref(state.projectId)} className="font-semibold">
            {state.title}
          </Link>
          : {count(state.files, "file", "files")} and {count(state.folders, "folder", "folders")}.
        </span>
        {state.skipped.length > 0 ? (
          <>
            <span>{count(state.skipped.length, "path was", "paths were")} skipped, because this app cannot store them:</span>
            <ul className="grid gap-1 pl-4">
              {state.skipped.slice(0, SKIPPED_SHOWN).map(({ path, reason }, index) => (
                <li key={index} className="list-disc [overflow-wrap:anywhere]">
                  <code>{path}</code> {reason}
                </li>
              ))}
            </ul>
            {state.skipped.length > SKIPPED_SHOWN ? <span>And {state.skipped.length - SKIPPED_SHOWN} more.</span> : null}
          </>
        ) : null}
      </span>
    </Banner>
  )
}
