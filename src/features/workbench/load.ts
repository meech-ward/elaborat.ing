/**
 * The workbench (Monaco, Excalidraw, the note frame) is most of the app's
 * code, so it loads in a chunk of its own, once. Project routes start it on
 * navigation, so the session check and opening the project do not wait for it.
 */
let loading: Promise<typeof import("./WorkspaceWorkbench")> | null = null

export function loadWorkbench(): Promise<typeof import("./WorkspaceWorkbench")> {
  loading ??= import("./WorkspaceWorkbench").catch((error: unknown) => {
    // Let the next use try again.
    loading = null
    throw error
  })
  return loading
}

/** Start loading the workbench without waiting for it; a failure shows up where it is used. */
export function preloadWorkbench(): void {
  loadWorkbench().catch(() => {})
}
