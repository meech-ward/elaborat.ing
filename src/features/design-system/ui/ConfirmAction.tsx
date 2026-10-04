import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { AlertDialog, DialogContent, DialogFooter, DialogTitle } from "@/components/ui/dialog"

/** A question before an action that loses work, and the action's button label. */
export type ConfirmRequest = { message: string; confirmLabel?: string }

type Ask = (request: ConfirmRequest) => Promise<boolean>

/** The mounted ConfirmActionHost's way of asking, while there is one. */
let host: Ask | null = null

/**
 * Asks before an action that loses work, such as discarding unsaved edits,
 * and resolves true to go ahead. In the app's own window it is the browser's
 * confirm, as it has always been. While a ConfirmActionHost is mounted (the
 * app in a chat's panel, whose frame may block the browser's dialogs, which
 * then answer no at once) it is the library's dialog instead.
 */
export function confirmAction(message: string, options: { confirmLabel?: string } = {}): Promise<boolean> {
  if (host) return host({ message, ...options })
  return Promise.resolve(window.confirm(message))
}

/**
 * The question as an alert dialog: Cancel, which has the focus first, and the
 * action (`confirmLabel`, Continue by default). Escape and closing answer no.
 */
export function ConfirmDialog({
  open,
  message,
  confirmLabel = "Continue",
  onAnswer,
}: {
  open: boolean
  message: string
  confirmLabel?: string
  onAnswer: (confirmed: boolean) => void
}) {
  const cancel = useRef<HTMLButtonElement>(null)
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onAnswer(false)
      }}
    >
      <DialogContent initialFocus={cancel} showCloseButton={false}>
        <DialogTitle className="font-normal">{message}</DialogTitle>
        <DialogFooter>
          <Button ref={cancel} variant="outline" onClick={() => onAnswer(false)}>
            Cancel
          </Button>
          <Button onClick={() => onAnswer(true)}>{confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </AlertDialog>
  )
}

type Pending = ConfirmRequest & { answer: (confirmed: boolean) => void }

/**
 * Where confirmAction asks with the dialog: mount one where the browser's
 * dialogs may be blocked. Questions asked together are shown one at a time,
 * and any still open when it unmounts are answered no.
 */
export function ConfirmActionHost() {
  const [queue, setQueue] = useState<Pending[]>([])
  const pending = useRef<Pending[]>([])
  useEffect(() => {
    const ask: Ask = (request) =>
      new Promise((resolve) => {
        const entry = { ...request, answer: resolve }
        pending.current.push(entry)
        setQueue([...pending.current])
      })
    host = ask
    const waiting = pending.current
    return () => {
      if (host === ask) host = null
      for (const entry of waiting.splice(0)) entry.answer(false)
    }
  }, [])
  const current = queue[0]
  if (!current) return null
  const answer = (confirmed: boolean) => {
    if (pending.current[0] !== current) return
    pending.current.shift()
    current.answer(confirmed)
    setQueue([...pending.current])
  }
  return <ConfirmDialog open message={current.message} confirmLabel={current.confirmLabel} onAnswer={answer} />
}
