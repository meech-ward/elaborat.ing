import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { PanelPage } from "@/components/panel"
import { Button } from "@/components/ui/button"
import { Banner, BannerAction } from "@/features/design-system"
import type { DeletedProject, ProjectLibrary } from "@/features/project-storage/library"
import { downloadBlob } from "@/features/workbench/download"
import { zipName, zipProject } from "./projectArchive"

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
const files = (count: number) => (count === 1 ? "1 file" : `${count} files`)

/** Save a .zip of the changes to a deleted project that are only on this device. */
async function downloadUnsaved(library: ProjectLibrary, project: DeletedProject): Promise<void> {
  const changes = await library.unsavedChanges(project.id)
  if (changes.length === 0) throw new Error("There are no unsaved changes to download.")
  downloadBlob(new Blob([zipProject(changes, [])], { type: "application/zip" }), zipName(`${project.title} unsaved changes`))
}

/** Whether to remove a deleted project from this device: asked while it holds unsaved changes. */
const confirmRemove = (project: DeletedProject) =>
  project.unsaved === 0 || window.confirm(`Remove ${project.title} from this device? Its unsaved changes are lost unless you downloaded them.`)

/**
 * On the home page: a project its owner deleted. With unsaved changes still
 * on this device, it offers them as a .zip and removes them when asked;
 * otherwise the project has already left this device.
 */
export function DeletedProjectBanner({ library, project, onError }: {
  library: ProjectLibrary
  project: DeletedProject
  onError: (message: string) => void
}) {
  const run = (work: () => Promise<unknown>) => () => void work().catch((cause: unknown) => onError(message(cause)))
  return (
    <Banner
      tone="warn"
      action={
        project.unsaved > 0 ? (
          <span className="inline-flex flex-wrap gap-x-3">
            <BannerAction onClick={run(() => downloadUnsaved(library, project))}>Download unsaved changes</BannerAction>
            <BannerAction onClick={run(async () => confirmRemove(project) && (await library.removeDeleted(project.id)))}>Remove from this device</BannerAction>
          </span>
        ) : (
          <BannerAction onClick={run(() => library.removeDeleted(project.id))}>Dismiss</BannerAction>
        )
      }
    >
      {project.title} was deleted by its owner.
      {project.unsaved > 0 ? ` Your unsaved changes to ${files(project.unsaved)} are still on this device.` : ""}
    </Banner>
  )
}

/** In place of a project its owner deleted, with the way home and, while any are left, its unsaved changes. */
export function DeletedProjectPage({ library, project, onLeave }: {
  library: ProjectLibrary
  project: DeletedProject
  /** Go to the projects home; the project is removed once the page has left it. */
  onLeave: () => Promise<void>
}) {
  const [error, setError] = useState<string | null>(null)
  const run = (work: () => Promise<unknown>) => () => {
    setError(null)
    void work().catch((cause: unknown) => setError(message(cause)))
  }
  return (
    <PanelPage>
      <h1 className="text-[21px] leading-tight font-semibold [overflow-wrap:anywhere]">{project.title}</h1>
      <p role="status">
        This project was deleted by its owner.
        {project.unsaved > 0
          ? ` Your unsaved changes to ${files(project.unsaved)} are still on this device. Download them before you remove it.`
          : " It is no longer on this device."}
      </p>
      {project.unsaved > 0 ? (
        <div className="flex flex-wrap gap-2 pt-1">
          <Button onClick={run(() => downloadUnsaved(library, project))}>Download unsaved changes</Button>
          <Button
            variant="outline"
            onClick={run(async () => {
              if (!confirmRemove(project)) return
              await onLeave()
              await library.removeDeleted(project.id)
            })}
          >
            Remove from this device
          </Button>
        </div>
      ) : null}
      {error ? <p role="alert" className="text-destructive">{error}</p> : null}
      <p>
        <Link to="/" className="text-(--accent-soft-text) underline underline-offset-4">
          Back to your projects
        </Link>
      </p>
    </PanelPage>
  )
}
