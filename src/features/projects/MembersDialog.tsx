import { useEffect, useId, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { Member, ProjectLibrary } from "@/features/project-storage/library"
import type { MemberRole } from "@/features/project-storage/remote"

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

const ROLES: readonly MemberRole[] = ["viewer", "commenter", "editor"]
const roleName = { owner: "Owner", editor: "Editor", commenter: "Commenter", viewer: "Viewer" } as const
const aRole = (role: MemberRole) => (role === "editor" ? "an editor" : `a ${role}`)
/** Asked before anyone is made an editor, by invitation or by a role change. */
const EDITOR_WARNING = "Editors can change and delete files, and their agents can too."
const ROLE_ITEMS = ROLES.map((role) => ({ value: role, label: roleName[role] }))

/** A role picked from the shadcn select, named by `label` ("Role for ..."). */
function RoleSelect({ label, value, onChange }: { label: string; value: MemberRole; onChange: (role: MemberRole) => void }) {
  return (
    <Select
      items={ROLE_ITEMS}
      value={value}
      onValueChange={(next) => {
        const role = ROLES.find((entry) => entry === next)
        if (role) onChange(role)
      }}
    >
      <SelectTrigger aria-label={label} size="sm" className="min-w-28">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {ROLE_ITEMS.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** An account without an email address is named by the start of its id. */
const nameOf = (member: Member) => member.email ?? `Account ${member.userId.slice(0, 8)}`

/**
 * Who a project is shared with. Its owner can invite people by email, change
 * a member's role, and remove a member or an invitation after a confirmation;
 * making someone an editor is confirmed first too. Anyone else sees the list
 * only. Each change goes to the server at once, then the list is read again,
 * so it always shows what the server holds.
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
  const [email, setEmail] = useState("")
  const [inviteRole, setInviteRole] = useState<MemberRole>("viewer")
  const emailId = useId()
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
    if (role === "editor" && !window.confirm(`Make ${name} an editor of ${title}? ${EDITOR_WARNING}`)) return
    // Show the choice at once; the list is read again once the server answers.
    setMembers((current) => current?.map((entry) => (entry.userId === member.userId ? { ...entry, role } : entry)) ?? null)
    void change(member, role, member.invited ? `${name} is now invited as ${aRole(role)}.` : `${name} is now ${aRole(role)}.`, "Role not changed")
  }

  const invite = async () => {
    const address = email.trim()
    if (pending || !address) return
    if (members?.some((member) => member.email?.toLowerCase() === address.toLowerCase())) {
      setNotice(null)
      setError(`${address} already has access. Change their role in the list.`)
      return
    }
    if (inviteRole === "editor" && !window.confirm(`Invite ${address} to ${title} as an editor? ${EDITOR_WARNING}`)) return
    setPending(true)
    setError(null)
    setNotice(null)
    try {
      await library.invite(projectId, address, inviteRole)
      setNotice(`Invited ${address}.`)
      setEmail("")
    } catch (cause) {
      setError(`Not invited: ${message(cause)}`)
    }
    await load()
    setPending(false)
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
              ? "Invite people by email, change a member's role, or remove a member or an invitation. Changes apply at once."
              : "Who this project is shared with. Only its owner can change this."}
          </DialogDescription>
        </DialogHeader>
        {members === null && error === null ? <p role="status">Loading members…</p> : null}
        {owner && members ? (
          <form
            aria-label="Invite people"
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              void invite()
            }}
          >
            <Label htmlFor={emailId}>Invite by email</Label>
            <span className="flex flex-wrap items-center gap-2">
              <Input
                id={emailId}
                type="email"
                required
                autoComplete="off"
                placeholder="name@example.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="min-w-0 flex-1 basis-48"
              />
              <RoleSelect label="Role for the invitation" value={inviteRole} onChange={setInviteRole} />
              <Button type="submit" size="sm" disabled={pending}>
                Invite
              </Button>
            </span>
            <p className="text-sm text-muted-foreground">People without an account get an email to join.</p>
          </form>
        ) : null}
        {members ? (
          <ul
            ref={list}
            tabIndex={-1}
            aria-label="Members"
            aria-busy={pending}
            className="flex flex-col divide-y divide-border rounded-lg border border-border outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
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
                      <RoleSelect label={`Role for ${name}`} value={member.role as MemberRole} onChange={(role) => changeRole(member, role)} />
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
