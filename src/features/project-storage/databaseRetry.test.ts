import { expect, test } from "bun:test"
import { IDBFactory } from "fake-indexeddb"
import { IndexedProjectDatabase } from "./database"
import type { LocalProject } from "./model"

const project = (): LocalProject => ({
  partition: "one", id: crypto.randomUUID(), title: "Before", pendingTitle: null,
  role: "owner", revision: 1, created: true, archivedAt: null, syncError: null, pending: null,
})

type Injection = (tx: IDBTransaction) => void

/** Control one connection's native transactions without changing global IDB prototypes. */
function database() {
  const factory = new IDBFactory()
  const injections: Injection[] = []
  const open = factory.open.bind(factory)
  factory.open = (name, version) => {
    const opening = open(name, version)
    opening.addEventListener("success", () => {
      const raw = opening.result
      const transaction = raw.transaction.bind(raw)
      raw.transaction = (stores, mode, options) => {
        const tx = transaction(stores, mode, options)
        injections.shift()?.(tx)
        return tx
      }
    })
    return opening
  }
  return { db: new IndexedProjectDatabase(factory), inject: (injection: Injection) => { injections.push(injection) } }
}

/** End the native transaction before the first read's promise continuation. */
function completeAfterFirstRead(tx: IDBTransaction) {
  const store = tx.objectStore.bind(tx)
  let first = true
  tx.objectStore = name => {
    const result = store(name)
    if (first) {
      first = false
      const get = result.get.bind(result)
      result.get = key => {
        const pending = get(key)
        pending.addEventListener("success", () => tx.commit(), { once: true })
        return pending
      }
    }
    return result
  }
}

test("a prematurely completed read phase returns one fresh atomic snapshot on its only retry", async () => {
  const { db, inject } = database(), p = project()
  await db.transaction(p.partition, "readwrite", tx => tx.putProject(p))
  inject(tx => {
    completeAfterFirstRead(tx)
    tx.addEventListener("complete", () => {
      // This complete update queues before the retry, so no values from the
      // discarded first read may leak into the result.
      const update = tx.db.transaction(["projects", "files"], "readwrite")
      update.objectStore("projects").put({ ...p, title: "After", revision: 2 })
      update.objectStore("files").put({
        partition: p.partition, projectId: p.id, path: "new.md", localId: crypto.randomUUID(),
        content: "After", base: null, batch: null, draft: null, conflict: null,
      })
    }, { once: true })
  })
  let attempts = 0
  const snapshot = await db.transaction(p.partition, "readonly", async tx => {
    attempts++
    return { project: await tx.getProject(p.id), files: await tx.listFiles(p.id) }
  })
  expect(attempts).toBe(2)
  expect(snapshot.project).toMatchObject({ title: "After", revision: 2 })
  expect(snapshot.files.map(file => file.content)).toEqual(["After"])
})

test("a first write rejected by native inactivity can retry before any mutation is accepted", async () => {
  const { db, inject } = database(), p = project()
  await db.transaction(p.partition, "readwrite", tx => tx.putProject(p))
  inject(completeAfterFirstRead)
  let attempts = 0
  await db.transaction(p.partition, "readwrite", async tx => {
    attempts++
    const current = (await tx.getProject(p.id))!
    await tx.putProject({ ...current, revision: current.revision + 1 })
  })
  expect(attempts).toBe(2)
  expect((await db.listProjects(p.partition))[0].revision).toBe(2)
})

test("parallel native read failures retain the first rejected request's retry signal", async () => {
  const { db, inject } = database(), p = project()
  await db.transaction(p.partition, "readwrite", tx => tx.putProject(p))
  inject(completeAfterFirstRead)
  let attempts = 0
  const entries = await db.transaction(p.partition, "readonly", async tx => {
    attempts++
    await tx.getProject(p.id)
    return Promise.all([tx.listFiles(p.id), tx.listFolders(p.id)])
  })
  expect(attempts).toBe(2)
  expect(entries).toEqual([[], []])
})

test("repeated native premature completion stops after one retry and preserves the native error", async () => {
  const { db, inject } = database(), p = project()
  await db.transaction(p.partition, "readwrite", tx => tx.putProject(p))
  inject(completeAfterFirstRead)
  inject(completeAfterFirstRead)
  let attempts = 0
  const work = db.transaction(p.partition, "readonly", async tx => {
    attempts++
    await tx.getProject(p.id)
    return tx.listFiles(p.id)
  })
  await expect(work).rejects.toMatchObject({ name: "InvalidStateError" })
  expect(attempts).toBe(2)
})

test("native inactivity after an accepted write never replays a mutation", async () => {
  const { db, inject } = database(), p = project()
  await db.transaction(p.partition, "readwrite", tx => tx.putProject(p))
  inject(tx => {
    const store = tx.objectStore.bind(tx)
    tx.objectStore = name => {
      const result = store(name), put = result.put.bind(result)
      result.put = (...args) => {
        const pending = put(...args)
        pending.addEventListener("success", () => tx.commit(), { once: true })
        return pending
      }
      return result
    }
  })
  let attempts = 0
  await expect(db.transaction(p.partition, "readwrite", async tx => {
    attempts++
    await tx.putProject({ ...p, revision: 2 })
    await tx.listFiles(p.id)
  })).rejects.toMatchObject({ name: "InvalidStateError" })
  expect(attempts).toBe(1)
  expect((await db.listProjects(p.partition))[0].revision).toBe(2)
})

test("aborted native read phases do not retry", async () => {
  const { db, inject } = database(), p = project()
  await db.transaction(p.partition, "readwrite", tx => tx.putProject(p))
  inject(tx => {
    const store = tx.objectStore.bind(tx)
    tx.objectStore = name => {
      const result = store(name), get = result.get.bind(result)
      result.get = key => {
        const pending = get(key)
        pending.addEventListener("success", () => tx.abort(), { once: true })
        return pending
      }
      return result
    }
  })
  let attempts = 0
  await expect(db.transaction(p.partition, "readonly", async tx => {
    attempts++
    await tx.getProject(p.id)
    await tx.listFiles(p.id)
  })).rejects.toMatchObject({ name: "InvalidStateError" })
  expect(attempts).toBe(1)
})

test("native quota failures preserve their original error without retrying", async () => {
  const { db, inject } = database(), p = project()
  await db.transaction(p.partition, "readwrite", tx => tx.putProject(p))
  const quota = new DOMException("Full storage", "QuotaExceededError")
  inject(tx => {
    const store = tx.objectStore.bind(tx)
    tx.objectStore = name => {
      const result = store(name)
      result.put = () => { throw quota }
      return result
    }
  })
  let attempts = 0
  await expect(db.transaction(p.partition, "readwrite", async tx => {
    attempts++
    await tx.putProject({ ...p, revision: 2 })
  })).rejects.toBe(quota)
  expect(attempts).toBe(1)
  expect((await db.listProjects(p.partition))[0].revision).toBe(1)
})

test("an inactive error thrown by callback code is not a native retry signal", async () => {
  const { db } = database(), p = project()
  const error = new DOMException("Application error", "InvalidStateError")
  let attempts = 0
  await expect(db.transaction(p.partition, "readwrite", async tx => {
    attempts++
    await tx.getProject(p.id)
    throw error
  })).rejects.toBe(error)
  expect(attempts).toBe(1)
})
