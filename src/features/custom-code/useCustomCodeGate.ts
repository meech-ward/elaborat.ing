import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import type { ComponentEnvironment } from "@/features/document/componentModules"
import { approveCode, approvedCode, codeFiles, NO_APPROVALS, subscribeApprovals, waitingFiles, type CodeFile } from "./approvals"
import type { CustomCodePolicy } from "./context"

type ComponentState = { environment?: ComponentEnvironment; error?: string; pending?: boolean }

export type CustomCodeGate =
  /** Show the note: `components` is what the rendered view may run. */
  | { kind: "open"; components: ComponentState }
  /** Ask first: the files whose code the note runs, and the choice to run them. */
  | { kind: "ask"; files: CodeFile[]; run: () => void }

/**
 * Whether a note's rendered view may run its custom components now. Without
 * a policy (the person's own project) it always may. In a shared project a
 * note that imports component files, exports code itself, or has an
 * expression in its text that runs code (componentModules.ts) waits until
 * the person chooses to run that exact code; the choice is remembered per
 * file version (approvals.ts). Built-in components never ask.
 *
 * The rendered view gets only an environment whose code was checked: while
 * a newer one is being checked it keeps the last one, whose source no longer
 * matches the note, so it waits instead of running unchecked code. The
 * person's own unsaved edits to a running note's exports (`dirty`) keep it
 * running; a change from elsewhere asks again.
 */
export function useCustomCodeGate(policy: CustomCodePolicy | null, notePath: string, components: ComponentState, dirty: boolean): CustomCodeGate {
  const environment = components.environment
  const key = policy?.key ?? null
  const custom = key !== null && environment !== undefined && environment.code.length > 0
  const [checked, setChecked] = useState<{ environment: ComponentEnvironment; files: CodeFile[] } | null>(null)
  const approved = useSyncExternalStore(subscribeApprovals, () => (key !== null ? approvedCode(key) : NO_APPROVALS))
  // What the last render showed, and whether the note had unsaved edits, for the check below.
  const running = useRef(false)
  const editing = useRef(dirty)

  useEffect(() => {
    if (!custom || key === null || !environment) return
    let cancelled = false
    void codeFiles(environment.code, notePath).then((files) => {
      if (cancelled) return
      const waiting = waitingFiles(files, approvedCode(key))
      if (running.current && editing.current && waiting.length > 0 && waiting.every((file) => file.own)) {
        approveCode(key, waiting.map((file) => file.token))
      }
      setChecked({ environment, files })
    })
    return () => {
      cancelled = true
    }
  }, [custom, environment, key, notePath])

  let gate: CustomCodeGate
  if (!custom || key === null) gate = { kind: "open", components }
  else if (!checked) gate = { kind: "open", components: { pending: true } }
  else {
    const waiting = waitingFiles(checked.files, approved)
    gate =
      waiting.length === 0
        ? { kind: "open", components: { ...components, environment: checked.environment } }
        : { kind: "ask", files: checked.files, run: () => approveCode(key, waiting.map((file) => file.token)) }
  }
  const shown = gate.kind === "open" && !(custom && !checked)

  useEffect(() => {
    running.current = shown
    editing.current = dirty
  })
  return gate
}
