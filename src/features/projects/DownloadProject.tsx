import { useId, useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import type { ProjectLibrary } from "@/features/project-storage/library"
import { RemoteError } from "@/features/project-storage/remote"
import { downloadBlob } from "@/features/workbench/download"
import { fileStoreFor } from "./account"
import { filesToDownload, zipName, zipProject } from "./projectArchive"

type Snapshot = Awaited<ReturnType<ReturnType<typeof fileStoreFor>["snapshot"]>>

function save(snapshot: Snapshot, title: string, drafts: boolean) {
  const zip = zipProject(filesToDownload(snapshot.files, drafts), snapshot.folders)
  downloadBlob(new Blob([zip], { type: "application/zip" }), zipName(title))
}

/**
 * Download a project as a .zip, built on this device from its copy there, so
 * it works offline. A project not on this device yet is downloaded first
 * (that needs a connection). When files have unsaved changes, a dialog asks
 * whether to include them; otherwise the download starts at once.
 */
export function useProjectDownload(library: ProjectLibrary, onError: (message: string) => void) {
  const [asking, setAsking] = useState<{ title: string; snapshot: Snapshot } | null>(null)

  const start = async (projectId: string, title: string) => {
    try {
      let found: boolean
      try {
        found = await library.open(projectId)
      } catch (cause) {
        if (cause instanceof RemoteError && cause.kind === "network") throw new Error("This project is not on this device yet, and downloading it needs a connection.")
        throw cause
      }
      if (!found) throw new Error("This project is not on this device or the server.")
      const snapshot = await fileStoreFor(library, projectId).snapshot()
      if (snapshot.files.some((file) => file.draft !== null)) setAsking({ title, snapshot })
      else save(snapshot, title, false)
    } catch (cause) {
      onError(`Not downloaded: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }

  const dialog = asking ? (
    <DownloadDialog
      title={asking.title}
      drafts={asking.snapshot.files.filter((file) => file.draft !== null).length}
      onDownload={(drafts) => {
        setAsking(null)
        try {
          save(asking.snapshot, asking.title, drafts)
        } catch (cause) {
          onError(`Not downloaded: ${cause instanceof Error ? cause.message : String(cause)}`)
        }
      }}
      onClose={() => setAsking(null)}
    />
  ) : null
  return { start, dialog }
}

/** Asks whether a download includes the unsaved changes on this device; it leaves them out unless asked. */
function DownloadDialog({ title, drafts, onDownload, onClose }: {
  title: string
  /** Files with unsaved changes. */
  drafts: number
  onDownload: (includeDrafts: boolean) => void
  onClose: () => void
}) {
  const [include, setInclude] = useState(false)
  const switchId = useId()
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            onDownload(include)
          }}
        >
          <DialogHeader>
            <DialogTitle>Download {title}</DialogTitle>
            <DialogDescription>
              {drafts === 1 ? "1 file has unsaved changes." : `${drafts} files have unsaved changes.`} The .zip has the saved copies unless you
              include them.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor={switchId}>Include unsaved changes</Label>
            <Switch id={switchId} checked={include} onCheckedChange={setInclude} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">Download</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
