import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import type { Member, ProjectLibrary } from "@/features/project-storage/library"
import type { MemberRole } from "@/features/project-storage/remote"

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

const ROLES: readonly MemberRole[] = ["viewer", "commenter", "editor"]
const roleName = { owner: "Owner", editor: "Editor", commenter: "Commenter", viewer: "Viewer" } as const
const aRole = (role: MemberRole) => (role === "editor" ? "an editor" : `a ${role}`)
/** An account without an email address is named by the start of its id. */
const nameOf = (member: Member) => member.email ?? `Account ${member.userId.slice(0, 8)}`

/**
 * Who a project is shared with. Its owner can change a member's role, and
 * remove a member or an invitation after a confirmation; anyone else sees the
 * list only. Each change goes to the server at once, then the list is read
 * again, so it always shows what the server holds.
 */
export function MembersDialog({ library, projectId, title, owner, you, onClose }: {
  library: ProjectLibrary
  projectId: string
  title: string
  /** The signed-in person owns the project, so may change who has access. */
  owner: boolean
  /** The signed-in person's user id, to mark their own entry. */
  you: string
  onClose: () => void
}) {
  const [members, setMembers] = useState<Member[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const list = useRef<HTMLUListElement>(null)
  const close = useRef<HTMLButtonElement>(null)

  const load = async () => {
    try {
      setMembers(await library.members(projectId))
    } catch (cause) {
      setError(message(cause))
    }
  }
  useEffect(() => {
    let current = true
    library.members(projectId).then(
      (listed) => current && setMembers(listed),
      (cause: unknown) => current && setError(message(cause)),
    )
    return () => {
      current = false
    }
  }, [library, projectId])

  const change = async (member: Member, role: MemberRole | null, done: string, failed: string) => {
    setPending(true)
    setError(null)
    setNotice(null)
    try {
      await library.share(projectId, member.userId, role)
      setNotice(done)
    } catch (cause) {
      setError(`${failed}: ${message(cause)}`)
    }
    await load()
    setPending(false)
  }

  const changeRole = (member: Member, role: MemberRole) => {
    if (pending || role === member.role) return
    const name = nameOf(member)
    // Show the choice at once; the list is read again once the server answers.
    setMembers((current) => current?.map((entry) => (entry.userId === member.userId ? { ...entry, role } : entry)) ?? null)
    void change(member, role, member.invited ? `${name} is now invited as ${aRole(role)}.` : `${name} is now ${aRole(role)}.`, "Role not changed")
  }

  const remove = async (member: Member) => {
    if (pending) return
    const name = nameOf(member)
    const question = member.invited ? `Remove the invitation for ${name} to ${title}?` : `Remove ${name} from ${title}? They lose access to it.`
    if (!window.confirm(question)) return
    await change(member, null, member.invited ? `Removed the invitation for ${name}.` : `Removed ${name}.`, "Not removed")
    // Their row, and the button that had focus, are gone.
    list.current?.focus()
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent showCloseButton={false} initialFocus={close} className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Members of {title}</DialogTitle>
          <DialogDescription>
            {owner
              ? "Change a member's role, or remove a member or an invitation. Changes apply at once."
              : "Who this project is shared with. Only its owner can change this."}
          </DialogDescription>
        </DialogHeader>
        {members === null && error === null ? <p role="status">Loading members…</p> : null}
        {members ? (
          <ul
            ref={list}
            tabIndex={-1}
            aria-label="Members"
            aria-busy={pending}
            className="flex flex-col divide-y rounded-lg border outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {members.map((member) => {
              const name = nameOf(member)
              const editable = owner && member.role !== "owner"
              return (
                <li key={member.userId} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3 py-2">
                  <span className="flex min-w-0 flex-col">
                    <span className="font-medium wrap-anywhere">
                      {name}
                      {member.userId === you ? " (you)" : ""}
                    </span>
                    {member.invited ? (
                      <span className="text-muted-foreground">Invited, not yet accepted</span>
                    ) : editable ? null : (
                      <span className="text-muted-foreground">{roleName[member.role]}</span>
                    )}
                  </span>
                  {editable ? (
                    <span className="flex items-center gap-2">
                      <select
                        aria-label={`Role for ${name}`}
                        value={member.role}
                        onChange={(event) => {
                          const role = ROLES.find((entry) => entry === event.target.value)
                          if (role) changeRole(member, role)
                        }}
                        className="h-8 rounded-lg border border-input bg-background px-2 text-sm"
                      >
                        {ROLES.map((role) => (
                          <option key={role} value={role}>
                            {roleName[role]}
                          </option>
                        ))}
                      </select>
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={member.invited ? `Remove the invitation for ${name}` : `Remove ${name}`}
                        onClick={() => void remove(member)}
                      >
                        Remove
                      </Button>
                    </span>
                  ) : null}
                </li>
              )
            })}
          </ul>
        ) : null}
        {notice ? <p role="status">{notice}</p> : null}
        {error ? (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button ref={close} variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
