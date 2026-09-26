import type postgres from 'npm:postgres@3.4.9'
import type { FileRow, PassageRow, PassageStore } from './jobs.ts'

const QUEUE = 'file_passages'

/** The passage store over a direct database connection, as Supabase's automatic embeddings guide does. */
export function postgresStore(sql: postgres.Sql): PassageStore {
  return {
    async file(fileId) {
      const [row] = await sql<Array<{ id: string; project_id: string; path: string; content: string; version: string }>>`
        select id, project_id, path, content, version::text from public.project_files where id = ${fileId}
      `
      return row ? { id: row.id, projectId: row.project_id, path: row.path, content: row.content, version: row.version } : null
    },
    async replace(file: FileRow, rows: PassageRow[], jobId: number) {
      await sql.begin(async (tx) => {
        const [current] = await tx`select version::text as version from public.project_files where id = ${file.id} for share`
        if (current?.version === file.version) {
          await tx`delete from public.file_passages where file_id = ${file.id}`
          for (const row of rows) {
            await tx`
              insert into public.file_passages
                (file_id, project_id, ordinal, headings, content, start_offset, end_offset, embedding)
              values (${file.id}, ${file.projectId}, ${row.ordinal}, ${row.headings}, ${row.content},
                ${row.startOffset}, ${row.endOffset}, ${JSON.stringify(row.embedding)}::extensions.vector)
            `
          }
        }
        await tx`select pgmq.delete(${QUEUE}, ${jobId}::bigint)`
      })
    },
    async finish(jobId) {
      await sql`select pgmq.delete(${QUEUE}, ${jobId}::bigint)`
    },
  }
}
