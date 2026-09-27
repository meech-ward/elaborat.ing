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
  /**
   * Replace the file's passages and finish the job, in one transaction. When
   * the file has changed since `file.version`, write nothing: a newer job for
   * that change is already queued.
   */
  replace(file: FileRow, rows: PassageRow[], jobId: number): Promise<void>
  /** Finish a job with nothing to write. */
  finish(jobId: number): Promise<void>
}

/** Embedding for one passage: 384 numbers from gte-small, normalized. */
export type Embed = (text: string) => Promise<number[]>

/** What the embedding model reads for a passage: its headings, then its text. */
export function embeddingInput(headings: string[], text: string): string {
  return headings.length ? `${headings.join(' > ')}\n\n${text}` : text
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
  for (const [ordinal, passage] of passages.entries()) {
    rows.push({
      ordinal,
      headings: passage.headings.join(' > '),
      content: passage.text,
      startOffset: passage.start,
      endOffset: passage.end,
      embedding: await embed(embeddingInput(passage.headings, passage.text)),
    })
  }
  await store.replace(file, rows, job.jobId)
}

export type Outcome = { completed: Job[]; failed: Array<Job & { error: string }> }

/** Each job on its own: one failure leaves the rest to finish, and its job returns to the queue. */
export async function processJobs(jobs: Job[], store: PassageStore, embed: Embed): Promise<Outcome> {
  const outcome: Outcome = { completed: [], failed: [] }
  for (const job of jobs) {
    try {
      await processJob(job, store, embed)
      outcome.completed.push(job)
    } catch (error) {
      outcome.failed.push({ ...job, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return outcome
}
