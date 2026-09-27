import { Link } from "@tanstack/react-router"
import { FileUp } from "lucide-react"
import { useState } from "react"
import { buttonVariants } from "@/components/ui/button"
import { Banner, Hint } from "@/features/design-system"
import type { ProjectLibrary } from "@/features/project-storage/library"
import { projectHref } from "@/features/navigation"
import { cn } from "@/lib/utils"
import { fileStoreFor } from "./account"
import { importPrototype, planImport, readPrototypeExport, type ImportPlan } from "./prototypeImport"

export type ImportState =
  | { kind: "idle" }
  | { kind: "importing"; name: string }
  | { kind: "failed"; message: string }
  | { kind: "done"; projectId: string; title: string; files: number; folders: number; skipped: ImportPlan["skipped"] }

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * Importing a project exported from the prototype as a .json file: the
 * state, and `choose` for the file field. A file that fails the checks
 * creates nothing; paths this app cannot store are skipped and listed with
 * the reason for each.
 */
export function useProjectImport(library: ProjectLibrary) {
  const [state, setState] = useState<ImportState>({ kind: "idle" })

  const choose = async (input: HTMLInputElement) => {
    const file = input.files?.[0]
    // Let the same file be chosen again.
    input.value = ""
    if (!file) return
    setState({ kind: "importing", name: file.name })
    const read = readPrototypeExport(await file.text())
    if (!read.ok) {
      setState({ kind: "failed", message: `${file.name} could not be imported. ${read.error}` })
      return
    }
    const plan = planImport(read.value)
    try {
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

/**
 * Import a project, as a quiet ghost button: the file field is hidden
 * behind its label, which looks like the button and says what file it takes
 * in a tooltip (and to screen readers).
 */
export function ImportProjectButton({ state, onChoose }: { state: ImportState; onChoose: (input: HTMLInputElement) => void }) {
  return (
    <span className="flex">
      <input
        id="import-project"
        type="file"
        accept=".json,application/json"
        aria-describedby="import-project-hint"
        disabled={state.kind === "importing"}
        onChange={(event) => onChoose(event.currentTarget)}
        className="peer sr-only"
      />
      <Hint label={HINT}>
        <label
          htmlFor="import-project"
          className={cn(
            buttonVariants({ variant: "ghost" }),
            "peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring peer-focus-visible:outline-solid peer-disabled:pointer-events-none peer-disabled:opacity-45",
          )}
        >
          <FileUp aria-hidden="true" />
          Import a project
        </label>
      </Hint>
      <span id="import-project-hint" className="sr-only">
        {HINT}
      </span>
    </span>
  )
}

const HINT = "A .json file exported from the prototype."

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
              {state.skipped.map(({ path, reason }) => (
                <li key={path} className="list-disc [overflow-wrap:anywhere]">
                  <code>{path}</code> {reason}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </span>
    </Banner>
  )
}
