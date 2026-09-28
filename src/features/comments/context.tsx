import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from "react"
import type { CommentsController, CommentsUiState } from "./controller"
import type { RemoteThread } from "./remote"
import type { CommentsStatus, ProjectComments } from "./store"

/**
 * The comments of the open project, for everything on its page: the panel
 * and the file views. ProjectPage provides it for a project on the server;
 * elsewhere (the local project) there is none, and nothing offers comments.
 */
export type ProjectCommentsValue = {
  store: ProjectComments
  controller: CommentsController
  /** The signed-in person. */
  userId: string
  /** The project's owner may delete anyone's comments. */
  owner: boolean
  /** A viewer reads comments but cannot write them (the panel says so). */
  viewer: boolean
  /** May start, reply to and resolve threads now: a commenter, editor or owner, online, the project not archived. */
  canWrite: boolean
  /** Why writing is off for someone who could otherwise write ("Comments need a connection."), or null. */
  writeBlocked: string | null
}

const ProjectCommentsContext = createContext<ProjectCommentsValue | null>(null)

export function ProjectCommentsProvider({ value, children }: { value: ProjectCommentsValue | null; children: ReactNode }) {
  return <ProjectCommentsContext value={value}>{children}</ProjectCommentsContext>
}

/** The open project's comments, or null where there are none (the local project, or outside a project). */
export function useProjectComments(): ProjectCommentsValue | null {
  return useContext(ProjectCommentsContext)
}

const NO_STATE: CommentsUiState = { target: null, panelOpen: false, activeThreadId: null, request: null }
const noSubscription = () => () => {}

/** The panel's and the file's shared state (the file on screen, the open thread, a new comment), re-rendering on change. */
export function useCommentsUi(): CommentsUiState {
  const comments = useProjectComments()
  const controller = comments?.controller
  return useSyncExternalStore(controller?.subscribe ?? noSubscription, controller ? controller.getState : () => NO_STATE)
}

const NO_THREADS: readonly RemoteThread[] = []

/**
 * A file's threads, loaded when first asked for and kept current by the
 * store (it reloads on the project's change signal). Null `fileId`: none.
 */
export function useFileThreads(fileId: string | null): { threads: readonly RemoteThread[]; status: CommentsStatus } {
  const comments = useProjectComments()
  const store = comments?.store
  const subscribe = store ? (listener: () => void) => store.subscribe(listener) : noSubscription
  const threads = useSyncExternalStore(subscribe, () => (store && fileId ? store.threads(fileId) : NO_THREADS))
  const status = useSyncExternalStore(subscribe, () => (store && fileId ? store.status(fileId) : "idle"))
  useEffect(() => {
    if (store && fileId && store.status(fileId) === "idle") void store.load(fileId)
  }, [fileId, store])
  return { threads, status }
}
