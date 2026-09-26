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
