import { LocalFile, LocalFolder, LocalProject } from "./model"

/**
 * Durable on-device storage for projects, their files and folders.
 *
 * All reads and writes happen inside a transaction, which is the durability
 * boundary: it either commits completely or leaves nothing behind. Inside
 * `work`, await only the transaction's own methods. IndexedDB commits a
 * transaction as soon as it has no pending requests, so awaiting anything
 * else (a hash, a network call) would end it early.
 */
export interface StorageTransaction {
  getProject(id: string): Promise<LocalProject | null>
  putProject(project: LocalProject): Promise<void>
  /** Deletes the project with all its files and folders. */
  deleteProject(id: string): Promise<void>
  getFile(projectId: string, path: string): Promise<LocalFile | null>
  listFiles(projectId: string): Promise<LocalFile[]>
  /** The local file whose server copy has this id, if any. */
  findFileByBaseId(projectId: string, baseId: string): Promise<LocalFile | null>
  putFile(file: LocalFile): Promise<void>
  deleteFile(projectId: string, path: string): Promise<void>
  listFolders(projectId: string): Promise<LocalFolder[]>
  putFolder(folder: LocalFolder): Promise<void>
  deleteFolder(projectId: string, path: string): Promise<void>
}

export interface ProjectDatabase {
  listProjects(partition: string): Promise<LocalProject[]>
  transaction<T>(partition: string, mode: "readonly" | "readwrite", work: (tx: StorageTransaction) => Promise<T>): Promise<T>
}

function checkPartition(partition: string, record: { partition: string }): void {
  if (record.partition !== partition) throw new Error("A record cannot move between accounts.")
}

type MemoryState = {
  projects: Map<string, LocalProject>
  files: Map<string, LocalFile>
  folders: Map<string, LocalFolder>
}

const projectKey = (partition: string, id: string) => JSON.stringify([partition, id])
const entryKey = (partition: string, projectId: string, path: string) => JSON.stringify([partition, projectId, path])

/**
 * An in-memory database with the same transaction rules, for tests and for
 * browsers without IndexedDB. Transactions run one at a time; a transaction
 * that throws leaves no trace.
 */
export class MemoryProjectDatabase implements ProjectDatabase {
  private state: MemoryState = { projects: new Map(), files: new Map(), folders: new Map() }
  private queue: Promise<unknown> = Promise.resolve()

  async listProjects(partition: string): Promise<LocalProject[]> {
    await this.queue.catch(() => {})
    return [...this.state.projects.values()].filter((project) => project.partition === partition).map((project) => structuredClone(project))
  }

  transaction<T>(partition: string, _mode: "readonly" | "readwrite", work: (tx: StorageTransaction) => Promise<T>): Promise<T> {
    const run = async () => {
      const draft: MemoryState = structuredClone(this.state)
      const result = await work(memoryTransaction(partition, draft))
      this.state = draft
      return result
    }
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => {})
    return next
  }
}

function memoryTransaction(partition: string, state: MemoryState): StorageTransaction {
  const filesOf = (projectId: string) =>
    [...state.files.values()].filter((file) => file.partition === partition && file.projectId === projectId)
  const foldersOf = (projectId: string) =>
    [...state.folders.values()].filter((folder) => folder.partition === partition && folder.projectId === projectId)
  return {
    async getProject(id) {
      const project = state.projects.get(projectKey(partition, id))
      return project ? structuredClone(project) : null
    },
    async putProject(project) {
      checkPartition(partition, project)
      state.projects.set(projectKey(partition, project.id), LocalProject.parse(structuredClone(project)))
    },
    async deleteProject(id) {
      state.projects.delete(projectKey(partition, id))
      for (const file of filesOf(id)) state.files.delete(entryKey(partition, id, file.path))
      for (const folder of foldersOf(id)) state.folders.delete(entryKey(partition, id, folder.path))
    },
    async getFile(projectId, path) {
      const file = state.files.get(entryKey(partition, projectId, path))
      return file ? structuredClone(file) : null
    },
    async listFiles(projectId) {
      return filesOf(projectId).map((file) => structuredClone(file)).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    },
    async findFileByBaseId(projectId, baseId) {
      const file = filesOf(projectId).find((candidate) => candidate.base?.id === baseId)
      return file ? structuredClone(file) : null
    },
    async putFile(file) {
      checkPartition(partition, file)
      state.files.set(entryKey(partition, file.projectId, file.path), LocalFile.parse(structuredClone(file)))
    },
    async deleteFile(projectId, path) {
      state.files.delete(entryKey(partition, projectId, path))
    },
    async listFolders(projectId) {
      return foldersOf(projectId).map((folder) => structuredClone(folder)).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    },
    async putFolder(folder) {
      checkPartition(partition, folder)
      state.folders.set(entryKey(partition, folder.projectId, folder.path), LocalFolder.parse(structuredClone(folder)))
    },
    async deleteFolder(projectId, path) {
      state.folders.delete(entryKey(partition, projectId, path))
    },
  }
}

const DATABASE_NAME = "elaborating"
const DATABASE_VERSION = 1

/** IndexedDB storage. One transaction spans all three stores. */
export class IndexedProjectDatabase implements ProjectDatabase {
  private connection: Promise<IDBDatabase> | null = null

  constructor(private readonly factory: IDBFactory = indexedDB, private readonly name = DATABASE_NAME) {}

  private open(): Promise<IDBDatabase> {
    if (!this.connection) {
      this.connection = new Promise((resolve, reject) => {
        const request = this.factory.open(this.name, DATABASE_VERSION)
        request.onupgradeneeded = () => {
          const db = request.result
          const projects = db.createObjectStore("projects", { keyPath: ["partition", "id"] })
          projects.createIndex("partition", "partition")
          const files = db.createObjectStore("files", { keyPath: ["partition", "projectId", "path"] })
          files.createIndex("project", ["partition", "projectId"])
          files.createIndex("baseId", ["partition", "projectId", "base.id"])
          const folders = db.createObjectStore("folders", { keyPath: ["partition", "projectId", "path"] })
          folders.createIndex("project", ["partition", "projectId"])
        }
        request.onblocked = () => {
          this.connection = null
          reject(new Error("Close other elaborat.ing tabs so local storage can upgrade."))
        }
        request.onerror = () => {
          this.connection = null
          reject(request.error ?? new Error("Local storage could not open."))
        }
        request.onsuccess = () => {
          const db = request.result
          db.onversionchange = () => {
            db.close()
            this.connection = null
          }
          resolve(db)
        }
      })
    }
    return this.connection
  }

  async listProjects(partition: string): Promise<LocalProject[]> {
    return this.transaction(partition, "readonly", async (tx) => (tx as IndexedTransaction).allProjects())
  }

  async transaction<T>(partition: string, mode: "readonly" | "readwrite", work: (tx: StorageTransaction) => Promise<T>): Promise<T> {
    const db = await this.open()
    const idb = db.transaction(["projects", "files", "folders"], mode, { durability: "strict" })
    const done = new Promise<void>((resolve, reject) => {
      idb.oncomplete = () => resolve()
      idb.onabort = () => reject(idb.error ?? new Error("Local save did not complete; nothing was changed."))
      idb.onerror = () => reject(idb.error ?? new Error("Local storage failed."))
    })
    done.catch(() => {})
    let result: T
    try {
      result = await work(new IndexedTransaction(partition, idb))
    } catch (error) {
      try {
        idb.abort()
      } catch {
        // Already finished; the original error is what matters.
      }
      await done.catch(() => {})
      throw error
    }
    await done
    return result
  }
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error("Local storage request failed."))
  })
}

class IndexedTransaction implements StorageTransaction {
  constructor(private readonly partition: string, private readonly idb: IDBTransaction) {}

  private store(name: "projects" | "files" | "folders") {
    return this.idb.objectStore(name)
  }

  async allProjects(): Promise<LocalProject[]> {
    const rows = await request(this.store("projects").index("partition").getAll(this.partition))
    return rows.map((row) => LocalProject.parse(row))
  }

  async getProject(id: string) {
    const row = await request(this.store("projects").get([this.partition, id]))
    return row ? LocalProject.parse(row) : null
  }

  async putProject(project: LocalProject) {
    checkPartition(this.partition, project)
    await request(this.store("projects").put(LocalProject.parse(project)))
  }

  async deleteProject(id: string) {
    await request(this.store("projects").delete([this.partition, id]))
    for (const name of ["files", "folders"] as const) {
      const keys = await request(this.store(name).index("project").getAllKeys([this.partition, id]))
      for (const key of keys) await request(this.store(name).delete(key))
    }
  }

  async getFile(projectId: string, path: string) {
    const row = await request(this.store("files").get([this.partition, projectId, path]))
    return row ? LocalFile.parse(row) : null
  }

  async listFiles(projectId: string) {
    const rows = await request(this.store("files").index("project").getAll([this.partition, projectId]))
    return rows.map((row) => LocalFile.parse(row))
  }

  async findFileByBaseId(projectId: string, baseId: string) {
    const row = await request(this.store("files").index("baseId").get([this.partition, projectId, baseId]))
    return row ? LocalFile.parse(row) : null
  }

  async putFile(file: LocalFile) {
    checkPartition(this.partition, file)
    await request(this.store("files").put(LocalFile.parse(file)))
  }

  async deleteFile(projectId: string, path: string) {
    await request(this.store("files").delete([this.partition, projectId, path]))
  }

  async listFolders(projectId: string) {
    const rows = await request(this.store("folders").index("project").getAll([this.partition, projectId]))
    return rows.map((row) => LocalFolder.parse(row))
  }

  async putFolder(folder: LocalFolder) {
    checkPartition(this.partition, folder)
    await request(this.store("folders").put(LocalFolder.parse(folder)))
  }

  async deleteFolder(projectId: string, path: string) {
    await request(this.store("folders").delete([this.partition, projectId, path]))
  }
}
