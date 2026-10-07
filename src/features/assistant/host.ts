/**
 * What the assistant may do in the open project, which the workbench gives
 * it: the same operations a person has there, with their session. The
 * assistant never saves: a write lands as an unsaved edit in the file's tab.
 */
export type HostFileKind = "note" | "drawing" | "diagram" | "text"

export type HostFile = { path: string; kind: HostFileKind; unsaved: boolean }

export type HostRead = {
  path: string
  /** The text the editor holds, the person's unsaved changes included. */
  content: string
  /** The saved version on the server, or null for a file not synced yet. */
  version: number | null
  unsaved: boolean
}

export type HostThread = {
  id: string
  /** What it is on: the quoted text, a heading, an element, or the whole file. */
  on: string
  askAgent: boolean
  comments: Array<{ author: string; body: string; at: string }>
}

export interface AssistantHost {
  projectId: string
  /** Why the project can't be changed (a viewer, or archived), or null. */
  readOnly: string | null
  listFiles(): Promise<HostFile[]>
  /** The file as its editor holds it, or null when the project has no such file. */
  readFile(path: string): Promise<HostRead | null>
  /** The text of the file's tab when it has unsaved changes, else null. */
  unsavedText(path: string): Promise<string | null>
  /** Brings the file's tab forward while a write to it comes in (an existing file only). */
  show(path: string): Promise<void>
  /** The editor area the live view covers while a file is written. */
  liveContainer(): HTMLElement | null
  /**
   * Lands `content` as the file's unsaved edit in its tab, as typing would.
   * A new path is first created the way New file does. Throws with what is
   * wrong (a name that can't be used, say).
   */
  writeFile(path: string, content: string): Promise<{ created: boolean }>
  /** The file's open threads, or why there are none to read (no account, not synced yet). */
  listComments(path: string): Promise<HostThread[] | string>
}
