import { expect, test } from "bun:test"
import { MemoryProjectDatabase } from "./database"
import { ProjectLibrary } from "./library"
import { partitionKey } from "./model"
import { FakeProjectServer, OTHER, OWNER } from "./testing"

const partition = partitionKey("https://example.supabase.co", OWNER)

test("sync progress covers queued requests until the final request finishes, then publishes the refreshed state", async () => {
  const remote = new FakeProjectServer().remote(OWNER)
  const firstStarted = Promise.withResolvers<void>()
  const firstRelease = Promise.withResolvers<void>()
  const secondStarted = Promise.withResolvers<void>()
  const secondRelease = Promise.withResolvers<void>()
  let lists = 0
  const library = new ProjectLibrary(new MemoryProjectDatabase(), {
    ...remote,
    createProject: async (...args) => {
      firstStarted.resolve()
      await firstRelease.promise
      return remote.createProject(...args)
    },
    listProjects: async () => {
      if (++lists === 2) {
        secondStarted.resolve()
        await secondRelease.promise
      }
      return remote.listProjects()
    },
  }, partition)
  const id = await library.create("Progress")
  const first = library.syncProject(id)
  await firstStarted.promise
  expect(library.getState().syncing).toEqual([id])
  const second = library.syncProject(id)
  expect(library.getState().syncing).toEqual([id])
  firstRelease.resolve()
  await first
  await secondStarted.promise
  expect(library.getState().syncing).toEqual([id])
  secondRelease.resolve()
  await second
  expect(library.getState().syncing).toEqual([])
  expect(library.getState().entries.find(entry => entry.id === id)?.status).toBe("synced")
})

test("a thrown sync error clears progress and leaves the saved local project available", async () => {
  const remote = new FakeProjectServer().remote(OWNER)
  const library = new ProjectLibrary(new MemoryProjectDatabase(), {
    ...remote,
    createProject: async () => { throw new Error("Unexpected transport failure") },
  }, partition)
  const id = await library.create("Kept on this device")
  await expect(library.syncProject(id)).rejects.toThrow("Unexpected transport failure")
  expect(library.getState().syncing).toEqual([])
  expect(library.getState().entries.find(entry => entry.id === id)?.title).toBe("Kept on this device")
})

test("progress follows a recovered project id and clears when that project finishes", async () => {
  const server = new FakeProjectServer()
  const remote = server.remote(OWNER)
  const reached = Promise.withResolvers<string>()
  const release = Promise.withResolvers<void>()
  const library = new ProjectLibrary(new MemoryProjectDatabase(), {
    ...remote,
    listProjects: async () => {
      const projects = await remote.listProjects()
      reached.resolve(projects[0].id)
      await release.promise
      return projects
    },
  }, partition)
  const originalId = await library.create("Recovered project")
  await server.remote(OTHER).createProject(originalId, "Different owner's project")
  const work = library.syncProject(originalId)
  const recoveredId = await reached.promise
  expect(recoveredId).not.toBe(originalId)
  expect(library.getState().syncing).toEqual([recoveredId])
  release.resolve()
  expect(await work).toMatchObject({ status: "synced", projectId: recoveredId })
  expect(library.getState().syncing).toEqual([])
  expect(library.getState().entries.map(entry => entry.id)).toEqual([recoveredId])
})
