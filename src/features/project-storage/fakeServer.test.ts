import { expect, test } from "bun:test"
import { FakeProjectServer } from "./fakeServer"
import { RemoteError } from "./remote"
import { OTHER, OWNER } from "./testing"

// The stand-in's invitations follow `supabase/schemas/project_functions.sql`:
// share_project invites, accept_invitation and leave_project act only on the
// caller's own membership, and refusals are the database's 42501 ("access").

const THIRD = "3e4f5a6b-7c8d-4e9f-8a0b-1c2d3e4f5a6b"

async function sharedProject(server: FakeProjectServer) {
  const owner = server.remote(OWNER)
  const id = crypto.randomUUID()
  await owner.createProject(id, "Shared")
  await owner.saveFiles(id, crypto.randomUUID(), [{ op: "put", path: "a.md", content: "a" }])
  return id
}

async function refusal(work: Promise<unknown>): Promise<string> {
  try {
    await work
  } catch (error) {
    expect(error).toBeInstanceOf(RemoteError)
    expect((error as RemoteError).kind).toBe("access")
    return (error as Error).message
  }
  throw new Error("expected the call to be refused")
}

test("an invited person sees the project only after accepting, and with the invited role", async () => {
  const server = new FakeProjectServer()
  const id = await sharedProject(server)
  server.invite(id, OTHER, "editor")
  const other = server.remote(OTHER)
  expect(await other.listProjects()).toEqual([])
  await refusal(other.changedFiles(id, 0, 100))
  expect(await other.listInvitations()).toEqual([{ project_id: id, title: "Shared", role: "editor", invited_at: expect.any(String) }])

  expect(await other.acceptInvitation(id)).toMatchObject({ id, title: "Shared", role: "editor" })
  expect((await other.listProjects()).map((project) => [project.id, project.role])).toEqual([[id, "editor"]])
  expect(await other.listInvitations()).toEqual([])
  expect((await other.changedFiles(id, 0, 100)).map((file) => file.path)).toEqual(["a.md"])
  // Accepting again changes nothing.
  expect(await other.acceptInvitation(id)).toMatchObject({ id, role: "editor" })
})

test("invitations are listed newest first", async () => {
  const server = new FakeProjectServer()
  const [first, second] = [await sharedProject(server), await sharedProject(server)]
  server.invite(first, OTHER, "viewer")
  server.invite(second, OTHER, "commenter")
  expect((await server.remote(OTHER).listInvitations()).map((invitation) => [invitation.project_id, invitation.role])).toEqual([
    [second, "commenter"],
    [first, "viewer"],
  ])
})

test("only the invited person can accept, and only their own invitation", async () => {
  const server = new FakeProjectServer()
  const id = await sharedProject(server)
  server.invite(id, OTHER, "viewer")
  expect(await refusal(server.remote(THIRD).acceptInvitation(id))).toBe("No invitation for this project")
  expect(await refusal(server.remote(OWNER).acceptInvitation(id))).toBe("No invitation for this project")
  expect(await refusal(server.remote(THIRD).acceptInvitation(crypto.randomUUID()))).toBe("No invitation for this project")
  expect(await server.remote(THIRD).listProjects()).toEqual([])
  expect(await server.remote(OTHER).listInvitations()).toHaveLength(1)
})

test("a member can leave and loses access; the owner and anyone else cannot", async () => {
  const server = new FakeProjectServer()
  const id = await sharedProject(server)
  server.share(id, OTHER, "editor")
  expect(await refusal(server.remote(OWNER).leaveProject(id))).toBe("You are not a member of this project")
  expect(await refusal(server.remote(THIRD).leaveProject(id))).toBe("You are not a member of this project")

  const other = server.remote(OTHER)
  await other.leaveProject(id)
  expect(await other.listProjects()).toEqual([])
  await refusal(other.changedFiles(id, 0, 100))
  await refusal(other.leaveProject(id))
  expect((await server.remote(OWNER).listProjects()).map((project) => project.id)).toEqual([id])
})

test("leaving declines an invitation", async () => {
  const server = new FakeProjectServer()
  const id = await sharedProject(server)
  server.invite(id, OTHER, "editor")
  await server.remote(OTHER).leaveProject(id)
  expect(await server.remote(OTHER).listInvitations()).toEqual([])
  await refusal(server.remote(OTHER).acceptInvitation(id))
})

// Archiving and deleting follow set_project_archived and delete_project:
// owners and editors archive and unarchive, an archived project refuses saves
// and renames with 55000 ("archived"), and only the owner deletes.

test("owners and editors archive and unarchive; viewers, commenters and others cannot", async () => {
  const server = new FakeProjectServer()
  const id = await sharedProject(server)
  server.share(id, OTHER, "editor")
  const other = server.remote(OTHER)
  const archived = await other.archiveProject(id)
  expect(archived).toMatchObject({ id, role: "editor", archived_at: expect.any(String) })
  // Archiving again changes nothing.
  expect(await other.archiveProject(id)).toEqual(archived)
  expect(await server.remote(OWNER).unarchiveProject(id)).toMatchObject({ archived_at: null, role: "owner", revision: archived.revision + 1 })

  for (const role of ["viewer", "commenter"] as const) {
    server.share(id, OTHER, role)
    expect(await refusal(other.archiveProject(id))).toBe("Editor access required")
    expect(await refusal(other.unarchiveProject(id))).toBe("Editor access required")
  }
  expect(await refusal(server.remote(THIRD).archiveProject(id))).toBe("Project not found or access denied")
  expect(await refusal(server.remote(OWNER).archiveProject(crypto.randomUUID()))).toBe("Project not found or access denied")
})

test("an archived project can still be read, and refuses saves and renames until it is unarchived", async () => {
  const server = new FakeProjectServer()
  const id = await sharedProject(server)
  const owner = server.remote(OWNER)
  await owner.archiveProject(id)
  const put = () => owner.saveFiles(id, crypto.randomUUID(), [{ op: "put", path: "b.md", content: "b" }])
  await expect(put()).rejects.toMatchObject({ kind: "archived" })
  await expect(owner.renameProject(id, "Renamed")).rejects.toMatchObject({ kind: "archived" })
  expect((await owner.changedFiles(id, 0, 100)).map((file) => file.path)).toEqual(["a.md"])

  await owner.unarchiveProject(id)
  expect((await put()).status).toBe("saved")
})

test("only the owner deletes a project, and then it is gone for everyone", async () => {
  const server = new FakeProjectServer()
  const id = await sharedProject(server)
  server.share(id, OTHER, "editor")
  expect(await refusal(server.remote(OTHER).deleteProject(id))).toBe("Only the project owner can permanently delete it")
  expect(await refusal(server.remote(THIRD).deleteProject(id))).toBe("Only the project owner can permanently delete it")
  expect(await server.remote(OTHER).listProjects()).toHaveLength(1)

  await server.remote(OWNER).deleteProject(id)
  expect(await server.remote(OWNER).listProjects()).toEqual([])
  expect(await server.remote(OTHER).listProjects()).toEqual([])
  await refusal(server.remote(OWNER).changedFiles(id, 0, 100))
  await refusal(server.remote(OWNER).deleteProject(id))
})

// Listing and changing members follow list_members and share_project: the
// owner and accepted members list them, only the owner sees invitations, and
// only the owner changes them.

test("the owner lists everyone, invitations last; a member sees no invitations; anyone else is refused", async () => {
  const server = new FakeProjectServer()
  const id = await sharedProject(server)
  server.emails.set(OWNER, "owner@example.com")
  server.emails.set(OTHER, "other@example.com")
  server.names.set(OTHER, "Other Person")
  server.invite(id, THIRD, "commenter")
  server.share(id, OTHER, "editor")

  const listed = await server.remote(OWNER).listMembers(id)
  expect(listed).toEqual([
    // Without a name, an account is named by its email.
    { user_id: OWNER, email: "owner@example.com", name: "owner@example.com", role: "owner", invited_at: null, accepted_at: null },
    { user_id: OTHER, email: "other@example.com", name: "Other Person", role: "editor", invited_at: expect.any(String), accepted_at: expect.any(String) },
    // An account without an email lists as null.
    { user_id: THIRD, email: null, name: null, role: "commenter", invited_at: expect.any(String), accepted_at: null },
  ])
  expect((await server.remote(OTHER).listMembers(id)).map((member) => member.user_id)).toEqual([OWNER, OTHER])
  expect(await refusal(server.remote(THIRD).listMembers(id))).toBe("Project unavailable")
  expect(await refusal(server.remote(crypto.randomUUID()).listMembers(id))).toBe("Project unavailable")
  expect(await refusal(server.remote(OWNER).listMembers(crypto.randomUUID()))).toBe("Project unavailable")
})

test("only the owner changes a role or removes someone, and an invitation stays one when its role changes", async () => {
  const server = new FakeProjectServer()
  const id = await sharedProject(server)
  server.share(id, OTHER, "editor")
  server.invite(id, THIRD, "commenter")
  const owner = server.remote(OWNER)
  const revision = server.projects.get(id)!.revision

  await owner.shareProject(id, OTHER, "viewer")
  await owner.shareProject(id, THIRD, "editor")
  const roles = async () => (await owner.listMembers(id)).map((member) => [member.user_id, member.role, member.accepted_at !== null])
  expect(await roles()).toEqual([
    [OWNER, "owner", false],
    [OTHER, "viewer", true],
    [THIRD, "editor", false],
  ])
  expect((await server.remote(OTHER).listProjects()).map((project) => project.role)).toEqual(["viewer"])
  expect(await server.remote(THIRD).listProjects()).toEqual([])
  expect(server.projects.get(id)!.revision).toBe(revision + 2)
  // The same role again changes nothing.
  await owner.shareProject(id, OTHER, "viewer")
  expect(server.projects.get(id)!.revision).toBe(revision + 2)

  expect(await refusal(server.remote(OTHER).shareProject(id, THIRD, null))).toBe("Only the project owner can change sharing")
  expect(await refusal(owner.shareProject(crypto.randomUUID(), OTHER, null))).toBe("Only the project owner can change sharing")
  await expect(owner.shareProject(id, OWNER, "viewer")).rejects.toMatchObject({ kind: "invalid", message: "Invalid member" })

  await owner.shareProject(id, OTHER, null)
  await owner.shareProject(id, THIRD, null)
  expect(await roles()).toEqual([[OWNER, "owner", false]])
  expect(await server.remote(OTHER).listProjects()).toEqual([])
  expect(await server.remote(THIRD).listInvitations()).toEqual([])
  expect(server.projects.get(id)!.revision).toBe(revision + 4)
  // Removing someone who is not there changes nothing.
  await owner.shareProject(id, OTHER, null)
  expect(server.projects.get(id)!.revision).toBe(revision + 4)
})
