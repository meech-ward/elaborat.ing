import { useId, useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Confirm deleting a project permanently by typing its title. Once the delete
 * starts, the dialog stays open until it settles; a refusal shows here.
 */
export function DeleteProjectDialog({ title, unsynced, onDelete, onClose }: {
  title: string
  /** Files on this device with changes the server does not have. They are deleted too. */
  unsynced: number
  onDelete: () => Promise<void>
  onClose: () => void
}) {
  const [typed, setTyped] = useState("")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputId = useId()

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (typed !== title || pending) return
    setPending(true)
    setError(null)
    try {
      await onDelete()
    } catch (cause) {
      setError(message(cause))
      setPending(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose()
      }}
    >
      <DialogContent showCloseButton={false}>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Delete {title} permanently</DialogTitle>
            <DialogDescription>
              This deletes the project and all its files, for everyone it is shared with. It cannot be undone. Agents cannot do this; they can
              only archive a project.
            </DialogDescription>
          </DialogHeader>
          {unsynced > 0 ? (
            <p>
              {unsynced === 1 ? "1 file on this device has changes" : `${unsynced} files on this device have changes`} that have not synced.
              They are deleted too.
            </p>
          ) : null}
          <div className="grid gap-2">
            <Label htmlFor={inputId}>Type {title} to confirm</Label>
            <Input
              id={inputId}
              value={typed}
              autoComplete="off"
              spellCheck={false}
              disabled={pending}
              onChange={(event) => setTyped(event.target.value)}
            />
          </div>
          {error ? (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={typed !== title || pending}>
              {pending ? "Deleting…" : "Delete permanently"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
