import { LocalFile, LocalFolder, LocalProject, type LocalImageAsset } from "./model"
import { matchesDiagnostic, projectDiagnostic, ProjectDiagnosticStorage, type SyncDiagnostic, type SyncDiagnosticStorage } from "./syncDiagnosticStorage"

/**
 * Durable on-device storage for projects, their files and folders.
 *
 * All reads and writes happen inside a transaction, which is the durability
 * boundary: it either commits completely or leaves nothing behind. Inside
 * `work`, await only the transaction's own methods. IndexedDB commits a
 * transaction as soon as it has no pending requests, so awaiting anything
 * else (a hash, a network call) would end it early. Before the first write,
 * keep other work pure: a native premature completion can retry that read
 * phase once. Never send network requests or publish state inside `work`.
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
  getAsset(projectId: string, id: string): Promise<LocalImageAsset | null>
  listAssets(projectId: string): Promise<LocalImageAsset[]>
  putAsset(asset: LocalImageAsset): Promise<void>
  /** Evict only unreferenced, never-uploaded local staging bytes. */
  deleteAsset(projectId: string, id: string): Promise<void>
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
  assets: Map<string, LocalImageAsset>
}

const projectKey = (partition: string, id: string) => JSON.stringify([partition, id])
const entryKey = (partition: string, projectId: string, path: string) => JSON.stringify([partition, projectId, path])

/**
 * An in-memory database with the same transaction rules, for tests and for
 * browsers without IndexedDB. Transactions run one at a time; a transaction
 * that throws leaves no trace.
 */
export class MemoryProjectDatabase implements ProjectDatabase {
  private state: MemoryState = { projects: new Map(), files: new Map(), folders: new Map(), assets: new Map() }
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
    async getAsset(projectId, id) {
      return structuredClone(state.assets.get(entryKey(partition, projectId, id)) ?? null)
    },
    async listAssets(projectId) {
      return [...state.assets.values()].filter((asset) => asset.partition === partition && asset.projectId === projectId).map((asset) => structuredClone(asset))
    },
    async putAsset(asset) {
      checkPartition(partition, asset)
      state.assets.set(entryKey(partition, asset.projectId, asset.id), structuredClone(asset))
    },
    async deleteAsset(projectId, id) {
      state.assets.delete(entryKey(partition, projectId, id))
    },
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
      for (const asset of state.assets.values()) if (asset.partition === partition && asset.projectId === id) state.assets.delete(entryKey(partition, id, asset.id))
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
const DATABASE_VERSION = 3

/** IndexedDB storage. One transaction spans metadata and binary assets. */
export class IndexedProjectDatabase implements ProjectDatabase {
  private connection: Promise<IDBDatabase> | null = null
  private upgraded = false
  private readonly diagnostics: ProjectDiagnosticStorage

  constructor(private readonly factory: IDBFactory = indexedDB, private readonly name = DATABASE_NAME, diagnosticStorage?: SyncDiagnosticStorage | null) {
    this.diagnostics = new ProjectDiagnosticStorage(diagnosticStorage)
  }

  private open(): Promise<IDBDatabase> {
    if (this.upgraded) return Promise.reject(new Error("A newer elaborat.ing tab upgraded local storage. Reload this tab before saving again. Your stored drafts are kept."))
    if (!this.connection) {
      this.connection = new Promise((resolve, reject) => {
        const request = this.factory.open(this.name, DATABASE_VERSION)
        let abandoned = false
        request.onupgradeneeded = (event) => {
          if (abandoned) { request.transaction?.abort(); return }
          const db = request.result
          if (!db.objectStoreNames.contains("projects")) {
            const projects = db.createObjectStore("projects", { keyPath: ["partition", "id"] })
            projects.createIndex("partition", "partition")
            const files = db.createObjectStore("files", { keyPath: ["partition", "projectId", "path"] })
            files.createIndex("project", ["partition", "projectId"])
            files.createIndex("baseId", ["partition", "projectId", "base.id"])
            const folders = db.createObjectStore("folders", { keyPath: ["partition", "projectId", "path"] })
            folders.createIndex("project", ["partition", "projectId"])
          }
          if (!db.objectStoreNames.contains("assets")) {
            const assets = db.createObjectStore("assets", { keyPath: ["partition", "projectId", "id"] })
            assets.createIndex("project", ["partition", "projectId"])
          }
          if (event.oldVersion > 0 && event.oldVersion < 3) {
            // An old download may have created its project row and stopped
            // before taking in metadata. Revision zero proves no completeness.
            const cursor = request.transaction!.objectStore("projects").openCursor()
            cursor.onsuccess = () => {
              const row = cursor.result
              if (!row) return
              const project = row.value
              if (project.created === true && project.revision === 0 && project.partial === undefined) {
                row.update({ ...project, partial: { revision: 0, metadata: false } })
              }
              row.continue()
            }
          }
        }
        request.onblocked = () => {
          abandoned = true
          this.connection = null
          reject(new Error("Close other elaborat.ing tabs so local storage can upgrade."))
        }
        request.onerror = () => {
          this.connection = null
          reject(request.error?.name === "VersionError" ? new Error("A newer elaborat.ing tab upgraded local storage. Reload this tab before saving again. Your stored drafts are kept.") : request.error ?? new Error("Local storage could not open."))
        }
        request.onsuccess = () => {
          const db = request.result
          if (abandoned) { db.close(); return }
          db.onversionchange = () => {
            this.upgraded = true
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
    for (let attempt = 0; ; attempt++) {
      const idb = db.transaction(["projects", "files", "folders", "assets"], mode, { durability: "strict" })
      let completed = false
      const done = new Promise<void>((resolve, reject) => {
        idb.oncomplete = () => { completed = true; resolve() }
        idb.onabort = () => reject(idb.error ?? new Error("Local save did not complete; nothing was changed."))
        idb.onerror = () => reject(idb.error ?? new Error("Local storage failed."))
      })
      done.catch(() => {})
      const transaction = new IndexedTransaction(partition, idb, this.diagnostics)
      let result: T
      try {
        result = await work(transaction)
      } catch (error) {
        try {
          idb.abort()
        } catch {
          // Already finished; the original error is what matters.
        }
        await done.catch(() => {})
        // Firefox can complete an otherwise valid read phase before its success
        // continuation runs. Only replay proven native inactivity after a clean
        // completion, with no accepted mutation. Aborts and failed writes keep
        // their original error and are never replayed.
        if (attempt === 0 && completed && transaction.canRetry(error)) continue
        throw error
      }
      await done
      transaction.commitDiagnostics()
      return result
    }
  }
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error("Local storage request failed."))
  })
}

class IndexedTransaction implements StorageTransaction {
  private readonly diagnosticChanges = new Map<string, SyncDiagnostic | null>()
  private mutationAccepted = false
  private readonly inactiveErrors = new Set<unknown>()

  constructor(private readonly partition: string, private readonly idb: IDBTransaction, private readonly diagnostics: ProjectDiagnosticStorage) {}

  /** Sidecar writes happen only once the durable transaction succeeded. */
  commitDiagnostics(): void {
    for (const [projectId, diagnostic] of this.diagnosticChanges) this.diagnostics.write(this.partition, projectId, diagnostic)
  }

  private project(row: unknown): LocalProject {
    const project = LocalProject.parse(row)
    const diagnostic = this.diagnosticChanges.has(project.id) ? this.diagnosticChanges.get(project.id) : this.diagnostics.read(this.partition, project.id)
    if (diagnostic && matchesDiagnostic(project, diagnostic)) return { ...project, syncErrorDetail: diagnostic.detail }
    // An old tab may have cleared the stopped state, advanced its revision or
    // removed access. Observing that invalidates the extra explanation too.
    this.diagnosticChanges.set(project.id, null)
    return { ...project, syncErrorDetail: null }
  }

  private store(name: "projects" | "files" | "folders" | "assets") {
    return this.idb.objectStore(name)
  }

  canRetry(error: unknown): boolean {
    return !this.mutationAccepted && this.inactiveErrors.has(error)
  }

  /** Classify only errors thrown by native request creation, before it accepts a write. */
  private enqueue<T>(start: () => IDBRequest<T>, mutation = false): Promise<T> {
    let pending: IDBRequest<T>
    try {
      pending = start()
      if (mutation) this.mutationAccepted = true
    } catch (error) {
      if (error instanceof DOMException && (error.name === "InvalidStateError" || error.name === "TransactionInactiveError")) this.inactiveErrors.add(error)
      throw error
    }
    return request(pending)
  }

  async getAsset(projectId: string, id: string): Promise<LocalImageAsset | null> {
    return (await this.enqueue(() => this.store("assets").get([this.partition, projectId, id]))) ?? null
  }

  async listAssets(projectId: string): Promise<LocalImageAsset[]> {
    return this.enqueue(() => this.store("assets").index("project").getAll([this.partition, projectId]))
  }

  async putAsset(asset: LocalImageAsset) {
    checkPartition(this.partition, asset)
    await this.enqueue(() => this.store("assets").put(asset), true)
  }

  async deleteAsset(projectId: string, id: string) {
    await this.enqueue(() => this.store("assets").delete([this.partition, projectId, id]), true)
  }

  async allProjects(): Promise<LocalProject[]> {
    const rows = await this.enqueue(() => this.store("projects").index("partition").getAll(this.partition))
    return rows.map((row) => this.project(row))
  }

  async getProject(id: string) {
    const row = await this.enqueue(() => this.store("projects").get([this.partition, id]))
    if (row) return this.project(row)
    this.diagnosticChanges.set(id, null)
    return null
  }

  async putProject(project: LocalProject) {
    checkPartition(this.partition, project)
    const parsed = LocalProject.parse(project)
    // Diagnostics remain optional sidecar data; readiness is durable in v3 rows.
    const legacy = { ...parsed }
    delete legacy.syncErrorDetail
    await this.enqueue(() => this.store("projects").put(legacy), true)
    this.diagnosticChanges.set(project.id, projectDiagnostic(parsed))
  }

  async deleteProject(id: string) {
    await this.enqueue(() => this.store("projects").delete([this.partition, id]), true)
    this.diagnosticChanges.set(id, null)
    for (const name of ["files", "folders", "assets"] as const) {
      const keys = await this.enqueue(() => this.store(name).index("project").getAllKeys([this.partition, id]))
      for (const key of keys) await this.enqueue(() => this.store(name).delete(key), true)
    }
  }

  async getFile(projectId: string, path: string) {
    const row = await this.enqueue(() => this.store("files").get([this.partition, projectId, path]))
    return row ? LocalFile.parse(row) : null
  }

  async listFiles(projectId: string) {
    const rows = await this.enqueue(() => this.store("files").index("project").getAll([this.partition, projectId]))
    return rows.map((row) => LocalFile.parse(row))
  }

  async findFileByBaseId(projectId: string, baseId: string) {
    const row = await this.enqueue(() => this.store("files").index("baseId").get([this.partition, projectId, baseId]))
    return row ? LocalFile.parse(row) : null
  }

  async putFile(file: LocalFile) {
    checkPartition(this.partition, file)
    const parsed = LocalFile.parse(file)
    await this.enqueue(() => this.store("files").put(parsed), true)
  }

  async deleteFile(projectId: string, path: string) {
    await this.enqueue(() => this.store("files").delete([this.partition, projectId, path]), true)
  }

  async listFolders(projectId: string) {
    const rows = await this.enqueue(() => this.store("folders").index("project").getAll([this.partition, projectId]))
    return rows.map((row) => LocalFolder.parse(row))
  }

  async putFolder(folder: LocalFolder) {
    checkPartition(this.partition, folder)
    const parsed = LocalFolder.parse(folder)
    await this.enqueue(() => this.store("folders").put(parsed), true)
  }

  async deleteFolder(projectId: string, path: string) {
    await this.enqueue(() => this.store("folders").delete([this.partition, projectId, path]), true)
  }
}

/**
 * Delete every project an account has on this device, with its files,
 * folders and drafts, in one transaction; other accounts' projects stay.
 * For an account that was deleted.
 */
export async function deleteAccountProjects(db: ProjectDatabase, partition: string): Promise<void> {
  const projects = await db.listProjects(partition)
  await db.transaction(partition, "readwrite", async (tx) => {
    for (const project of projects) await tx.deleteProject(project.id)
  })
}
