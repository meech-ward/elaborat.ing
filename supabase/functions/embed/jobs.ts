import { z } from 'npm:zod@4.4.3'
import { extractPassages } from '../_shared/passages.ts'

// Turns queued files into passages with embeddings. The database queues a job
// whenever a note, diagram or drawing is saved or renamed (private.queue_file_passages)
// and pg_cron sends batches here (private.process_file_passages).

export const JobSchema = z.object({ jobId: z.number().int(), fileId: z.uuid() })
export type Job = z.infer<typeof JobSchema>

/**
 * A file as it is now. `version` changes with every write. `diagramCanvas`
 * marks a D2 diagram's generated canvas (`flow.excalidraw` next to `flow.d2`),
 * whose words are the diagram's, so search finds them once, in the diagram.
 */
export type FileRow = { id: string; projectId: string; path: string; content: string; version: string; diagramCanvas?: boolean }

export type PassageRow = {
  ordinal: number
  headings: string
  content: string
  startOffset: number
  endOffset: number
  embedding: number[]
}

/** Where jobs read files and write passages. */
export interface PassageStore {
  /** The file, or null when it no longer exists (its passages went with it). */
  file(fileId: string): Promise<FileRow | null>
  /** The file's current passages, with their embeddings. */
  passages(fileId: string): Promise<Array<Pick<PassageRow, 'headings' | 'content' | 'embedding'>>>
  /** The embeddings kept for the file since its passages were last replaced, by input hash. */
  kept(fileId: string): Promise<Map<string, number[]>>
  /**
   * Keep a new embedding for the file straight away, outside any job's
   * transaction, so a job stopped partway loses none. `inputHash` is the
   * SHA-256, in hex, of what the model read (`embeddingInput`).
   */
  keep(fileId: string, inputHash: string, embedding: number[]): Promise<void>
  /**
   * Replace the file's passages, drop its kept embeddings and finish the job,
   * in one transaction. When the file has changed since `file.version`, write
   * nothing: a newer job for that change is already queued.
   */
  replace(file: FileRow, rows: PassageRow[], jobId: number): Promise<void>
  /** Finish a job with nothing to write. */
  finish(jobId: number): Promise<void>
  /** Show the jobs in the queue again after `seconds`, sooner than their visibility timeout would. */
  retryIn(jobIds: number[], seconds: number): Promise<void>
}

/** Embedding for one passage: 384 numbers from gte-small, normalized. */
export type Embed = (text: string) => Promise<number[]>

/** What the embedding model reads for a passage: its headings, then its text. */
export function embeddingInput(headings: string[], text: string): string {
  return headings.length ? `${headings.join(' > ')}\n\n${text}` : text
}

/** The SHA-256 of `text`, in hex: the key a kept embedding is stored under. */
async function inputHash(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * The embeddings the file already has, by input hash: its current passages',
 * so an edit embeds only the passages it changed, and the ones kept since,
 * so a job that stopped partway carries on where it stopped.
 */
async function knownEmbeddings(store: PassageStore, fileId: string): Promise<Map<string, number[]>> {
  const known = await store.kept(fileId)
  for (const passage of await store.passages(fileId)) {
    // Headings are joined with " > " and none is empty (passages.ts), so the
    // joined string gives back the input the passage was embedded from.
    const input = embeddingInput(passage.headings ? [passage.headings] : [], passage.content)
    known.set(await inputHash(input), passage.embedding)
  }
  return known
}

export async function processJob(job: Job, store: PassageStore, embed: Embed): Promise<void> {
  const file = await store.file(job.fileId)
  if (!file) {
    await store.finish(job.jobId)
    return
  }
  // A file that is not a note, diagram or drawing (after a rename, say) gets no passages.
  const rows: PassageRow[] = []
  const passages = file.diagramCanvas ? [] : extractPassages(file.path, file.content)
  const known = await knownEmbeddings(store, file.id)
  for (const [ordinal, passage] of passages.entries()) {
    const input = embeddingInput(passage.headings, passage.text)
    const hash = await inputHash(input)
    let embedding = known.get(hash)
    if (!embedding) {
      embedding = await embed(input)
      await store.keep(file.id, hash, embedding)
      known.set(hash, embedding)
    }
    rows.push({
      ordinal,
      headings: passage.headings.join(' > '),
      content: passage.text,
      startOffset: passage.start,
      endOffset: passage.end,
      embedding,
    })
  }
  await store.replace(file, rows, job.jobId)
}

export type Outcome = { completed: Job[]; failed: Array<Job & { error: string }> }

/**
 * Each job on its own: one failure leaves the rest to finish, and its job
 * returns to the queue. `outcome` fills in as each job ends, so a caller that
 * stops waiting partway knows which jobs are left.
 */
export async function processJobs(
  jobs: Job[],
  store: PassageStore,
  embed: Embed,
  outcome: Outcome = { completed: [], failed: [] },
): Promise<Outcome> {
  for (const job of jobs) {
    try {
      await processJob(job, store, embed)
      outcome.completed.push(job)
    } catch (error) {
      outcome.failed.push({ ...job, error: errorMessage(error) })
    }
  }
  return outcome
}

/**
 * How long the jobs a stop left stay hidden, in seconds, when the request kept
 * a new embedding first: long enough for the stopping worker to answer, short
 * enough for the next pg_cron run (every 10 seconds) to send them again.
 */
export const RETRY_AFTER_PROGRESS_SECONDS = 2

/**
 * Processes one request's batch. Just before the runtime stops the worker,
 * `stopping` aborts with the reason ("cpu" when the request has used most of
 * its CPU time), and the jobs left are reported failed. A file too long for
 * one request finishes over several tries, each carrying on from the
 * embeddings kept before it, so when this request kept a new one the jobs left
 * come back within seconds, the small files in the batch with them. Otherwise
 * they wait out their visibility timeout, minutes: a stop that kept nothing
 * new (on a host where not even one embedding fits, say) must not retry every
 * few seconds forever, and neither must a job that failed on its own. If
 * bringing the jobs back early fails, the timeout still brings them back.
 */
export async function processBatch(jobs: Job[], store: PassageStore, embed: Embed, stopping: AbortSignal): Promise<Outcome> {
  const stopped = new Promise<'stopped'>((resolve) => stopping.addEventListener('abort', () => resolve('stopped'), { once: true }))
  let kept = 0
  const outcome: Outcome = { completed: [], failed: [] }
  const work = processJobs(
    jobs,
    // Counts the new embeddings this request keeps: its progress.
    {
      ...store,
      keep: async (...args) => {
        await store.keep(...args)
        kept++
      },
    },
    // Starts no embedding once the worker is stopping, so the CPU time left
    // goes to bringing the jobs back and answering.
    async (text) => {
      stopping.throwIfAborted()
      return await embed(text)
    },
    outcome,
  )
  if ((await Promise.race([work, stopped])) !== 'stopped') return outcome

  const ended = new Set([...outcome.completed, ...outcome.failed].map((job) => job.jobId))
  const left = jobs.filter((job) => !ended.has(job.jobId))
  const result: Outcome = {
    completed: [...outcome.completed],
    failed: [...outcome.failed, ...left.map((job) => ({ ...job, error: String(stopping.reason) }))],
  }
  if (kept > 0 && left.length > 0) {
    try {
      await store.retryIn(left.map((job) => job.jobId), RETRY_AFTER_PROGRESS_SECONDS)
    } catch (error) {
      console.error('could not bring the jobs back early, so they return when their visibility timeout ends:', errorMessage(error))
    }
  }
  return result
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
