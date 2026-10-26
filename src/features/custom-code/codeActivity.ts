import type { CodeFile } from "./approvals"

/** A checked environment may keep running while its owner edits that same document. */
export type CodeActivity = { identity: number; key: string | null; running: boolean; editing: boolean }

export function nextCodeActivity(previous: CodeActivity, identity: number, key: string | null, editing: boolean, status: "running" | "checking" | "asking"): CodeActivity {
  const sameDocument = previous.identity === identity && previous.key === key
  return { identity, key, editing, running: status === "running" || (status === "checking" && sameDocument && previous.running) }
}

/** A new document or account never inherits permission to approve its own code. */
export function mayApproveOwnEdits(activity: CodeActivity, identity: number, key: string, waiting: readonly CodeFile[]): boolean {
  return activity.identity === identity && activity.key === key && activity.running && activity.editing &&
    waiting.length > 0 && waiting.every(file => file.own)
}
