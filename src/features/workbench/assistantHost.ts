import type { AssistantHost, HostThread } from "@/features/assistant/host"
import type { ProjectCommentsValue } from "@/features/comments"
import { LocalConflictError } from "@/features/project-storage/fileStore"
import { FLOW_D2_EXAMPLE } from "@/features/structured/examples"
import { hideGeneratedFiles } from "./folderTree"
import { newFilePath, type NewEntryKind } from "./newEntries"
import type { OperationSession } from "./operationSession"
import { kindForPath } from "./session"
import type { OpenTab, TabFile } from "./tabs"
import { MissingFileError, type WorkspaceFileRef, type WorkspaceStore } from "./workspaceStore"

/** What the workbench has now, read when the assistant asks (the host itself never changes). */
export type AssistantHostState = {
  files: readonly WorkspaceFileRef[]
  tabs: () => readonly OpenTab[]
  sessions: () => ReadonlyMap<string, OperationSession>
  /** Shows a file's content as its tab's unsaved edit. */
  land: (file: TabFile) => void
  liveContainer: () => HTMLElement | null
  /** Shows the file (a phone leaves its files screen). */
  reveal: () => void
  readOnly: string | null
  comments: ProjectCommentsValue | null
  takenNames: () => { files: string[]; dirs: string[] }
  openPath: (path: string) => Promise<boolean>
  refreshList: () => Promise<unknown>
}

/**
 * The assistant's way into this project (features/assistant/host.ts): the
 * workbench's own operations, with the person's session. A write lands as
 * an unsaved edit in the file's tab, as typing would; a new file is created
 * the way New file does first.
 */
export function makeAssistantHost(projectId: string, client: WorkspaceStore, latest: () => AssistantHostState): AssistantHost {
  const deps = { projectId, latest, tabs: () => latest().tabs(), sessions: () => latest().sessions(), land: (file: TabFile) => latest().land(file), reveal: () => latest().reveal() }
  /** The file's text as its tab holds it now, unsaved edits included. */
  const current = async (path: string) => {
    await deps.sessions().get(path)?.persistDraft?.()
    await client.flushLocalDrafts()
    try {
      return await client.read(path)
    } catch (error) {
      if (error instanceof MissingFileError) return null
      throw error
    }
  }
  const known = (path: string) => deps.latest().files.some((file) => file.path === path) || deps.tabs().some((tab) => tab.path === path)
  return {
    projectId: deps.projectId,
    get readOnly() {
      return deps.latest().readOnly
    },
    async listFiles() {
      const { files } = deps.latest()
      const tabs = deps.tabs()
      const paths = hideGeneratedFiles([...new Set([...files.map((file) => file.path), ...tabs.map((tab) => tab.path)])]).sort()
      return paths.map((path) => ({
        path,
        kind: kindForPath(path),
        unsaved: Boolean(files.find((file) => file.path === path)?.draft || tabs.find((tab) => tab.path === path)?.dirty),
      }))
    },
    async readFile(path) {
      if (!known(path)) return null
      const read = await current(path)
      if (!read) return null
      const server = deps.latest().files.find((file) => file.path === path)?.server ?? null
      return { path, content: read.content, version: server?.version ?? null, unsaved: read.draft || read.savedContent === null }
    },
    async unsavedText(path) {
      const tab = deps.tabs().find((entry) => entry.path === path)
      const draft = deps.latest().files.find((file) => file.path === path)?.draft
      if (!tab?.dirty && !draft) return null
      const read = await current(path)
      return read && read.content !== read.savedContent ? read.content : null
    },
    async show(path) {
      if (!known(path)) return
      deps.reveal()
      await deps.latest().openPath(path)
    },
    liveContainer: () => latest().liveContainer(),
    async writeFile(path, content) {
      const state = deps.latest()
      if (state.readOnly) throw new Error(`This project can't be changed: ${state.readOnly}`)
      let created = false
      let base: { revision: string | null; savedContent: string | null }
      if (!known(path)) {
        // A new file, created as New file creates one: saved at once with its starting content.
        const kind = kindForPath(path)
        const lower = path.toLowerCase()
        const entry: Exclude<NewEntryKind, "folder"> | null =
          kind === "drawing" && lower.endsWith(".excalidraw") ? "drawing" : kind === "diagram" ? "diagram" : lower.endsWith(".mdx") ? "mdx" : lower.endsWith(".md") ? "note" : null
        if (!entry) throw new Error("The assistant can create notes (.mdx or .md), drawings (.excalidraw) and diagrams (.d2).")
        const slash = path.lastIndexOf("/")
        const checked = newFilePath(entry, slash === -1 ? "" : path.slice(0, slash), path.slice(slash + 1), state.takenNames())
        if ("error" in checked) throw new Error(checked.error)
        const start = entry === "drawing" ? '{"type":"excalidraw","version":2,"elements":[]}' : entry === "diagram" ? FLOW_D2_EXAMPLE : ""
        let saved
        try {
          saved = await client.write(checked.path, { content: start, expectedRevision: null })
        } catch (cause) {
          if (cause instanceof LocalConflictError) throw new Error(`${checked.path} already exists.`)
          throw cause
        }
        await state.refreshList()
        base = { revision: saved.revision, savedContent: start }
        created = true
      } else {
        const read = await current(path)
        if (!read) throw new Error(`${path} is not in this project.`)
        base = { revision: read.revision, savedContent: read.savedContent }
      }
      // Kept on this device as the file's draft, then shown in its tab.
      await client.persistDrafts([{ path, content, baseRevision: base.revision }])
      await client.flushLocalDrafts()
      deps.reveal()
      deps.land({ path, content, revision: base.revision, savedContent: base.savedContent })
      return { created }
    },
    async listComments(path) {
      const { comments, files } = deps.latest()
      if (!comments) return "Comments need an account: this project is only in this browser."
      const file = files.find((entry) => entry.path === path)
      if (!file) return `${path} is not in this project.`
      const id = file.server?.id
      if (!id) return `${path} is not synced yet, so it has no comments.`
      if (comments.store.status(id) !== "loaded") await comments.store.load(id)
      return comments.store
        .threads(id)
        .filter((thread) => thread.resolved_at === null)
        .map(
          (thread): HostThread => ({
            id: thread.id,
            on: thread.anchor.kind === "document" ? "the whole file" : thread.anchor.kind === "element" ? `the element "${thread.anchor.label}"` : `"${thread.anchor.quote.exact}"`,
            askAgent: thread.ask_agent ?? false,
            comments: thread.comments
              .filter((comment) => comment.deleted_at === null && comment.body !== null)
              .map((comment) => ({ author: comment.author?.name || comment.author?.email || "Someone", body: comment.body ?? "", at: comment.created_at })),
          }),
        )
    },
  }
}
