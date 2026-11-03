import { useEffect, useId, useMemo, useRef, useState } from "react"
import { Button, buttonVariants } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { copyTextToClipboard } from "@/features/workbench/explorerActions"
import type { WorkspaceStore } from "@/features/workbench/workspaceStore"
import { loadedClient } from "@/lib/supabase/client"
import { fileSharingProblem } from "./ownerEligibility"
import { OwnerFileSharingRemote, sharedFileHref, type OwnerFileShare } from "./ownerRemote"

const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)

export function ShareFileDialog({ projectId, fileId, path, userId, workspace, onClose }: {
  projectId: string
  fileId: string
  path: string
  userId: string
  workspace: WorkspaceStore
  onClose: () => void
}) {
  const remote = useMemo(() => new OwnerFileSharingRemote(loadedClient(), userId), [userId])
  const [share, setShare] = useState<OwnerFileShare | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [blocked, setBlocked] = useState<string | null>(null)
  const close = useRef<HTMLButtonElement>(null)
  const linkInput = useRef<HTMLInputElement>(null)
  const linkId = useId()
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => { live.current = false }
  }, [])

  useEffect(() => {
    let current = true
    remote.get(projectId, fileId).then(
      value => { if (current) { setShare(value); setLoaded(true); setError(null) } },
      cause => { if (current) setError(message(cause)) },
    )
    return () => { current = false }
  }, [attempt, fileId, projectId, remote])

  useEffect(() => {
    let current = true
    let sequence = 0
    const check = async () => {
      const request = ++sequence
      try {
        const entries = await workspace.listEntries()
        if (current && request === sequence) setBlocked(fileSharingProblem(entries.files.find(file => file.server?.id === fileId)))
      } catch {
        if (current && request === sequence) setBlocked("Could not check this file's saved copy. Close sharing and try again.")
      }
    }
    void check()
    const unsubscribe = workspace.subscribe(() => void check())
    return () => { current = false; unsubscribe() }
  }, [fileId, workspace])

  const enabled = share !== null && share.revoked_at === null
  const href = enabled ? sharedFileHref(window.location.origin, share.token) : null
  const change = async (enable: boolean, replace = false) => {
    if (pending) return
    if (replace && !window.confirm("Replace this link? Anyone using the old link will lose access.")) return
    setPending(true)
    setError(null)
    setNotice(null)
    try {
      // Drafts, renames and a background sync can change after the dialog
      // opened. Check the stable server ID again immediately before sharing.
      if (enable) {
        const entries = await workspace.listEntries()
        const problem = fileSharingProblem(entries.files.find(file => file.server?.id === fileId))
        if (problem) { if (live.current) setBlocked(problem); throw new Error(problem) }
      }
      const value = await remote.set(projectId, fileId, enable, replace)
      if (enable && (!value || value.revoked_at !== null)) throw new Error("The link was not enabled. Try again.")
      if (!live.current) return
      setShare(value)
      setNotice(enable ? replace ? "Link replaced. The old link no longer works." : "Link enabled." : "Link disabled. Anyone using it has lost access.")
    } catch (cause) {
      if (live.current) setError(message(cause))
    } finally {
      if (live.current) setPending(false)
    }
  }

  const copy = async () => {
    if (!href) return
    setError(null)
    try {
      await copyTextToClipboard(href)
      if (live.current) setNotice("Link copied.")
    } catch {
      if (!live.current) return
      linkInput.current?.focus()
      linkInput.current?.select()
      setError("The browser could not copy the link. Copy the selected link manually.")
    }
  }

  return (
    <Dialog open onOpenChange={open => { if (!open && !pending) onClose() }}>
      <DialogContent showCloseButton={false} initialFocus={close} className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Share file</DialogTitle>
          <DialogDescription className="wrap-anywhere">{share?.path ?? path}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 text-sm">
          <p>Anyone with this unlisted link can view the latest saved content and forward the link. Sign-in is required only to leave a comment.</p>
          <p>Embedded documents, drawings, images and component files needed to render this file are included, along with their underlying source. The rest of the project stays private.</p>
          <p>Link comments are separate from private project comments.</p>
          {!loaded && !error ? <p role="status">Loading file sharing…</p> : null}
          {loaded ? (
            <p className="font-medium">{enabled ? "Link sharing is on." : "Link sharing is off."}</p>
          ) : null}
          {href ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor={linkId}>Unlisted file link</Label>
              <Input id={linkId} ref={linkInput} readOnly value={href} onFocus={event => event.currentTarget.select()} />
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" onClick={() => void copy()}>Copy link</Button>
                <a className={buttonVariants({ variant: "outline" })} href={href} target="_blank" rel="noreferrer">Open link</a>
              </div>
            </div>
          ) : null}
          {blocked ? <p role="status" className="text-muted-foreground">{blocked}</p> : null}
          {error ? <p role="alert" className="text-destructive">{error}</p> : null}
          {notice ? <p role="status">{notice}</p> : null}
        </div>
        <DialogFooter className="flex-wrap">
          <Button ref={close} variant="outline" disabled={pending} onClick={onClose}>Close</Button>
          {!loaded && error ? <Button onClick={() => { setError(null); setAttempt(value => value + 1) }}>Try again</Button> : null}
          {loaded && enabled ? (
            <>
              <Button variant="outline" disabled={pending || blocked !== null} onClick={() => void change(true, true)}>Replace link</Button>
              <Button variant="outline" disabled={pending} onClick={() => void change(false)}>Disable link</Button>
            </>
          ) : null}
          {loaded && !enabled ? <Button disabled={pending || blocked !== null} onClick={() => void change(true)}>Enable link</Button> : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
