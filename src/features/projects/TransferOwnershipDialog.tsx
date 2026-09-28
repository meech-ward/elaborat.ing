import { useEffect, useId, useState } from "react"
import { Button } from "@/components/ui/button"
import { AlertDialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { personName } from "@/features/auth/accountName"
import type { Member, ProjectLibrary } from "@/features/project-storage/library"

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
const roleName = { owner: "Owner", editor: "Editor", commenter: "Commenter", viewer: "Viewer" } as const

/** Someone by their name, else their email; an account with neither by the start of its id. */
const memberName = (member: Member) => personName(member.name, member.email) ?? `Account ${member.userId.slice(0, 8)}`

/** Who can take a project over: people who have accepted it, whatever their role. */
const takers = (members: Member[]) => members.filter((member) => member.role !== "owner" && !member.invited)

type Candidates = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; members: Member[] }

/**
 * Hand a project to one of its members: its owner picks who from the people
 * who have accepted it, and confirms with a button naming them. They become
 * the owner, and the person handing it over stays on as an editor. From the
 * Members dialog, with the member already picked and the list known; from
 * Delete account, which reads the list here. Open it through
 * LazyTransferOwnershipDialog, which loads it when first needed.
 */
export function TransferOwnershipDialog({ library, projectId, title, members, picked, onTransferred, onClose }: {
  library: ProjectLibrary
  projectId: string
  title: string
  /** The project's members, when already read; otherwise they are read here. */
  members?: Member[]
  /** Who to preselect. */
  picked?: string
  /** Done: called with the new owner's name. */
  onTransferred: (name: string) => void
  onClose: () => void
}) {
  const [candidates, setCandidates] = useState<Candidates>(members ? { status: "ready", members: takers(members) } : { status: "loading" })
  const [chosen, setChosen] = useState<string | null>(picked ?? null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const labelId = useId()

  useEffect(() => {
    if (members) return
    let current = true
    library.members(projectId).then(
      (listed) => {
        if (!current) return
        const found = takers(listed)
        setCandidates({ status: "ready", members: found })
        if (found.length === 1) setChosen((value) => value ?? found[0].userId)
      },
      (cause: unknown) => current && setCandidates({ status: "error", message: message(cause) }),
    )
    return () => {
      current = false
    }
  }, [library, projectId, members])

  const list = candidates.status === "ready" ? candidates.members : []
  const member = list.find((entry) => entry.userId === chosen) ?? null
  const items = list.map((entry) => ({ value: entry.userId, label: `${memberName(entry)} (${roleName[entry.role]})` }))

  const transfer = async () => {
    if (!member || pending) return
    setPending(true)
    setError(null)
    try {
      await library.transfer(projectId, member.userId)
      onTransferred(memberName(member))
    } catch (cause) {
      setError(`Not transferred: ${message(cause)}`)
      setPending(false)
    }
  }

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose()
      }}
    >
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Transfer {title}</DialogTitle>
          <DialogDescription>
            {member ? memberName(member) : "The new owner"} can then change who has access and delete the project permanently. You stay on as
            an editor, and only they can hand it back.
          </DialogDescription>
        </DialogHeader>
        {candidates.status === "loading" ? <p role="status">Loading members…</p> : null}
        {candidates.status === "error" ? (
          <p role="alert" className="text-destructive">
            {candidates.message}
          </p>
        ) : null}
        {candidates.status === "ready" && list.length === 0 ? (
          <p>Nobody has accepted an invitation to {title} yet. Once someone has, you can make them the owner.</p>
        ) : null}
        {list.length > 0 ? (
          <div className="grid gap-2">
            <Label id={labelId}>New owner</Label>
            <Select
              items={items}
              value={chosen}
              onValueChange={(next) => setChosen(typeof next === "string" ? next : null)}
              disabled={pending}
            >
              <SelectTrigger aria-labelledby={labelId} className="w-full">
                <SelectValue placeholder="Choose someone" />
              </SelectTrigger>
              <SelectContent>
                {items.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-sm text-muted-foreground">Only people who have accepted their invitation can become the owner.</p>
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" disabled={!member || pending} onClick={() => void transfer()}>
            {pending ? "Transferring…" : member ? `Make ${memberName(member)} the owner` : "Make owner"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </AlertDialog>
  )
}
