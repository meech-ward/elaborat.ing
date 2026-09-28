/**
 * Settings > Account > Delete account: says exactly what deleting does,
 * from the server's own summary, and asks the person to type their email.
 * Each owned project someone else has accepted offers "Transfer first", which
 * hands it to one of them (TransferOwnershipDialog) so it is kept.
 * Deleting runs the same guards as signing out; when one would keep unsaved
 * work, it says why and offers "Delete anyway".
 */
import { useEffect, useId, useState, type FormEvent } from "react"
import { Button } from "@/components/ui/button"
import { AlertDialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Banner, BannerAction } from "@/features/design-system"
import { libraryFor } from "@/features/projects/account"
import { LazyTransferOwnershipDialog } from "@/features/projects/LazyTransferOwnershipDialog"
import { deleteSignedInAccount, loadDeletionSummary, type DeletionSummary } from "./accountDeletion"

type Summary = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; summary: DeletionSummary }
type Problem = { kind: "kept"; reason: string } | { kind: "failed"; message: string } | null
type Owned = DeletionSummary["owned"][number]

const people = (count: number) => (count === 0 ? "Only you" : count === 1 ? "Shared with 1 person" : `Shared with ${count} people`)
const normal = (email: string) => email.trim().toLowerCase()

export function DeleteAccountDialog({ open, onOpenChange, userId, email, onDeleted }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  userId: string
  email: string
  onDeleted: () => void
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        {/* The popup unmounts once closed, so each opening starts afresh. */}
        <DeleteAccount userId={userId} email={email} onDeleted={onDeleted} />
      </DialogContent>
    </AlertDialog>
  )
}

function DeleteAccount({ userId, email, onDeleted }: { userId: string; email: string; onDeleted: () => void }) {
  const inputId = useId()
  const [summary, setSummary] = useState<Summary>({ status: "loading" })
  const [attempt, setAttempt] = useState(0)
  const [typed, setTyped] = useState("")
  const [pending, setPending] = useState(false)
  const [problem, setProblem] = useState<Problem>(null)
  const [transferring, setTransferring] = useState<Owned | null>(null)
  const [transferred, setTransferred] = useState<string | null>(null)
  const confirmed = normal(typed) === normal(email)

  useEffect(() => {
    let alive = true
    loadDeletionSummary().then(
      (loaded) => {
        if (alive) setSummary({ status: "ready", summary: loaded })
      },
      (cause: unknown) => {
        if (alive) setSummary({ status: "error", message: cause instanceof Error ? cause.message : String(cause) })
      },
    )
    return () => {
      alive = false
    }
  }, [attempt])

  const run = async (ignoreGuards: boolean) => {
    if (pending || !confirmed || summary.status !== "ready") return
    setPending(true)
    setProblem(null)
    // The server checks what was typed, not the address shown.
    const outcome = await deleteSignedInAccount(userId, typed, ignoreGuards)
    if (outcome.kind === "deleted") {
      onDeleted()
      return
    }
    setPending(false)
    setProblem(outcome)
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    void run(false)
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Delete your account?</DialogTitle>
        <DialogDescription>This cannot be undone. Here is what happens:</DialogDescription>
      </DialogHeader>
      {summary.status === "loading" ? (
        <p role="status" className="text-[13px] text-muted-foreground">
          Checking your projects...
        </p>
      ) : summary.status === "error" ? (
        <Banner
          tone="danger"
          action={
            <BannerAction
              onClick={() => {
                setSummary({ status: "loading" })
                setAttempt((value) => value + 1)
              }}
            >
              Try again
            </BannerAction>
          }
        >
          {summary.message}
        </Banner>
      ) : (
        <Consequences summary={summary.summary} onTransfer={pending ? undefined : setTransferring} />
      )}
      {transferred ? <p role="status" className="text-[13px]">{transferred}</p> : null}
      <div className="grid gap-2">
        <Label htmlFor={inputId}>Type {email} to confirm</Label>
        <Input
          id={inputId}
          value={typed}
          inputMode="email"
          autoComplete="off"
          spellCheck={false}
          disabled={pending}
          onChange={(event) => setTyped(event.target.value)}
        />
      </div>
      {problem?.kind === "kept" ? (
        <Banner
          tone="warn"
          action={
            <BannerAction disabled={pending} onClick={() => void run(true)}>
              Delete anyway
            </BannerAction>
          }
        >
          Nothing was deleted. {problem.reason} Or delete anyway, and lose any changes on this device.
        </Banner>
      ) : problem?.kind === "failed" ? (
        <Banner tone="danger">{problem.message}</Banner>
      ) : null}
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" disabled={pending} />}>Cancel</DialogClose>
        <Button type="submit" variant="destructive" disabled={pending || !confirmed || summary.status !== "ready"}>
          {pending ? "Deleting..." : "Delete account"}
        </Button>
      </DialogFooter>
      {transferring ? (
        <LazyTransferOwnershipDialog
          library={libraryFor({ userId, email, online: true })}
          projectId={transferring.id}
          title={transferring.title}
          onTransferred={(name) => {
            setTransferred(`${name} is now the owner of ${transferring.title}, so it is kept. You stay on as an editor.`)
            setTransferring(null)
            // Read the summary again: the project has left the list.
            setAttempt((value) => value + 1)
          }}
          onClose={() => setTransferring(null)}
        />
      ) : null}
    </form>
  )
}

/** What deleting does, in the order it happens. */
function Consequences({ summary, onTransfer }: { summary: DeletionSummary; onTransfer?: (project: Owned) => void }) {
  const { owned, shared } = summary
  const transferable = owned.some((project) => project.members > 0)
  return (
    <ul className="grid list-disc gap-2 pl-5 text-[13px] leading-normal">
      <li>
        {owned.length === 0 ? (
          "You own no projects, so none are deleted."
        ) : (
          <div className="grid gap-2">
            <span>
              {owned.length === 1
                ? "The project you own is deleted, for everyone it is shared with."
                : `The ${owned.length} projects you own are deleted, for everyone they are shared with.`}{" "}
              {transferable ? "To keep a shared project going, transfer it to someone it is shared with first. " : ""}To keep a copy, choose Download
              project in its menu first.
            </span>
            <ul aria-label="Projects you own" className="flex max-h-48 flex-col divide-y divide-border overflow-y-auto rounded-tile border border-border">
              {owned.map((project) => (
                <li key={project.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2">
                  <span className="flex min-w-0 flex-col">
                    <span className="font-medium break-words">{project.title}</span>
                    <span className="text-xs text-muted-foreground">
                      {people(project.members)}
                      {project.archived ? ", archived" : ""}
                    </span>
                  </span>
                  {project.members > 0 ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={`Transfer first: ${project.title}`}
                      disabled={!onTransfer}
                      onClick={() => onTransfer?.(project)}
                    >
                      Transfer first
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        )}
      </li>
      {shared > 0 ? <li>{shared === 1 ? "You leave the project shared with you." : `You leave the ${shared} projects shared with you.`}</li> : null}
      <li>Your comments stay where you wrote them, shown as from a deleted account.</li>
      <li>Agents you connected lose access.</li>
      <li>This device forgets your projects and drafts, and signs you out.</li>
    </ul>
  )
}
