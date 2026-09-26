import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { ProjectLibrary } from "@/features/project-storage/library"
import { projectHref } from "@/features/navigation"
import { fileStoreFor } from "./account"
import { importPrototype, planImport, readPrototypeExport, type ImportPlan } from "./prototypeImport"

type ImportState =
  | { kind: "idle" }
  | { kind: "importing"; name: string }
  | { kind: "failed"; message: string }
  | { kind: "done"; projectId: string; title: string; files: number; folders: number; skipped: ImportPlan["skipped"] }

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * Import a project exported from the prototype as a .json file. A file that
 * fails the checks creates nothing; paths this app cannot store are skipped
 * and listed with the reason for each.
 */
export function ImportProject({ library }: { library: ProjectLibrary }) {
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

  return (
    <div className="grid gap-2">
      <Label htmlFor="import-project">Import a project</Label>
      <Input
        id="import-project"
        type="file"
        accept=".json,application/json"
        aria-describedby="import-project-hint"
        disabled={state.kind === "importing"}
        onChange={(event) => void choose(event.currentTarget)}
      />
      <p id="import-project-hint" className="text-sm text-muted-foreground">
        A .json file exported from the prototype.
      </p>
      {state.kind === "importing" ? <p role="status" className="text-sm">Importing {state.name}…</p> : null}
      {state.kind === "failed" ? (
        <p role="alert" className="text-sm text-destructive [overflow-wrap:anywhere]">
          {state.message}
        </p>
      ) : null}
      {state.kind === "done" ? (
        <div role="status" className="grid gap-2 text-sm">
          <p>
            Imported{" "}
            <Link to={projectHref(state.projectId)} className="font-medium underline underline-offset-4">
              {state.title}
            </Link>
            : {count(state.files, "file", "files")} and {count(state.folders, "folder", "folders")}.
          </p>
          {state.skipped.length > 0 ? (
            <>
              <p>{count(state.skipped.length, "path was", "paths were")} skipped, because this app cannot store them:</p>
              <ul className="grid gap-1 pl-4">
                {state.skipped.map(({ path, reason }) => (
                  <li key={path} className="list-disc [overflow-wrap:anywhere]">
                    <code>{path}</code> {reason}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
