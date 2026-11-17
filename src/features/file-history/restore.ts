import type { ImageAsset } from "../images/types"
import { downloadImageAsset } from "../images/assetDownload"
import { nativePathFor, readDiagramCompanion } from "../workbench/diagramFiles"
import type { WorkspaceFile, WorkspaceFileRef, WorkspaceStore } from "../workbench/workspaceStore"
import type { FileVersion } from "./remote"
import { HistoryRestoreError } from "./errors"

export { HistoryRestoreError } from "./errors"

/** History restores content at the file's current path, without undoing moves. */
export function restoreBlocked(file: WorkspaceFileRef | undefined, version: FileVersion, readOnly?: string | null, dirty = false): string | null {
  if (readOnly) return readOnly
  if (!file?.revision || file.server?.id !== version.file_id) return "This file is no longer available on this device."
  if (dirty || file.draft || file.unsynced || file.conflict) return "Save or discard unsynced edits before restoring a version."
  if (version.deleted) return "This version records a deletion."
  if ((file.kind ?? "text") !== version.kind) return "This version has a different file type."
  return null
}

type RestoreWorkspace = Pick<WorkspaceStore, "listEntries" | "read" | "write" | "save" | "cacheImage" | "flushLocalDrafts">
type RestoreInput = {
  workspace: RestoreWorkspace
  projectId: string
  /** The clean, synced copy the person was looking at when they chose Restore. */
  file: WorkspaceFileRef
  version: FileVersion
  content: string | null
  readOnly?: string | null
  /** Includes mounted editor edits that have not reached draft storage yet. */
  isDirty?: (path: string) => boolean
  downloadImage?: (projectId: string, asset: ImageAsset, preview?: boolean) => Promise<Blob>
  /** Test port for compilation; the browser uses the existing diagram projection. */
  prepareDiagram?: typeof prepareDiagram
}

function sameCopy(expected: WorkspaceFileRef | null, current: WorkspaceFileRef | undefined): boolean {
  if (!expected) return !current
  return !!current && current.path === expected.path && current.revision === expected.revision
    && current.server?.id === expected.server?.id && current.server?.version === expected.server?.version
}

async function prepareDiagram(source: string, nativePath: string, native: WorkspaceFile | null, sidecar: WorkspaceFile | null): Promise<{ native: string; sidecar: string }> {
  return (await import("./prepareDiagram")).prepareDiagram(source, nativePath, native, sidecar)
}

/**
 * A normal local save, checked against the captured copy. Background sync
 * retains that copy's server base_version and uses normal conflict recovery.
 * History rows are never changed or removed.
 */
export async function restoreVersion(input: RestoreInput): Promise<string> {
  const { workspace, file, version, content, readOnly, isDirty = () => false } = input
  const blocked = restoreBlocked(file, version, readOnly, isDirty(file.path))
  if (blocked) throw new HistoryRestoreError(blocked)
  if (version.kind === "text" && content === null) throw new HistoryRestoreError("This version's text did not load.")
  if (version.kind === "image" && !version.asset) throw new HistoryRestoreError("This version's image did not load.")

  const check = async (copies: ReadonlyArray<{ path: string; file: WorkspaceFileRef | null }>) => {
    await workspace.flushLocalDrafts()
    const { files } = await workspace.listEntries()
    if (copies.some(copy => isDirty(copy.path))) throw new HistoryRestoreError("Finish pending edits and save or discard unsynced edits before restoring a version.")
    for (const copy of copies) {
      const current = files.find(candidate => candidate.path === copy.path)
      if (!sameCopy(copy.file, current)) throw new HistoryRestoreError(`${copy.path} changed while this version was being restored. Try again.`)
      if (current && (current.draft || current.unsynced || current.conflict)) throw new HistoryRestoreError(`Save or discard unsynced edits in ${copy.path} before restoring a version.`)
    }
  }
  const sourceCopy = { path: file.path, file }
  await check([sourceCopy])
  const current = await workspace.read(file.path)
  if (!sameCopy(file, current)) throw new HistoryRestoreError(`${file.path} changed while this version was being restored. Try again.`)
  if (version.kind === "image" ? current.asset?.id === version.asset?.id : current.savedContent === content) {
    throw new HistoryRestoreError("This version's content is already current.")
  }

  if (version.kind === "image" && version.asset) {
    if (!workspace.cacheImage) throw new HistoryRestoreError("Image history is unavailable on this device.")
    const download = input.downloadImage ?? downloadImageAsset
    const [bytes, preview] = await Promise.all([download(input.projectId, version.asset), download(input.projectId, version.asset, true)])
    await workspace.cacheImage(bytes, version.asset, preview)
    await check([sourceCopy])
    await workspace.save([{ kind: "asset", path: file.path, asset: version.asset, expectedRevision: file.revision, requireClean: true, expectedServer: file.server }])
  } else if (/\.d2$/i.test(file.path)) {
    const nativePath = nativePathFor(file.path)
    const sidecarPath = `${file.path}.json`
    const [native, sidecar] = await Promise.all([readDiagramCompanion(workspace, nativePath), readDiagramCompanion(workspace, sidecarPath)])
    const copies = [sourceCopy, { path: nativePath, file: native }, { path: sidecarPath, file: sidecar }]
    await check(copies)
    const generated = await (input.prepareDiagram ?? prepareDiagram)(content!, nativePath, native, sidecar)
    await check(copies)
    await workspace.save([
      { kind: "write", path: file.path, content: content!, expectedRevision: file.revision, requireClean: true, expectedServer: file.server },
      { kind: "write", path: nativePath, content: generated.native, expectedRevision: native?.revision ?? null, requireClean: true, expectedServer: native?.server ?? null },
      { kind: "write", path: sidecarPath, content: generated.sidecar, expectedRevision: sidecar?.revision ?? null, requireClean: true, expectedServer: sidecar?.server ?? null },
    ])
  } else {
    await check([sourceCopy])
    await workspace.save([{ kind: "write", path: file.path, content: content!, expectedRevision: file.revision, requireClean: true, expectedServer: file.server }])
  }
  return file.path
}
