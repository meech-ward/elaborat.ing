import type postgres from 'npm:postgres@3.4.9'
import type { FileRow, PassageRow, PassageStore } from './jobs.ts'

const QUEUE = 'file_passages'

/** The passage store over a direct database connection, as Supabase's automatic embeddings guide does. */
export function postgresStore(sql: postgres.Sql): PassageStore {
  return {
    async file(fileId) {
      const [row] = await sql<Array<{ id: string; project_id: string; path: string; content: string; version: string; diagram_canvas: boolean }>>`
        select f.id, f.project_id, f.path, f.content, f.version::text,
          f.path ~* '\\.excalidraw$' and exists (
            select 1 from public.project_files d
            where d.project_id = f.project_id and lower(d.path) = lower(regexp_replace(f.path, '\\.excalidraw$', '.d2', 'i'))
          ) as diagram_canvas
        from public.project_files f where f.id = ${fileId}
      `
      return row
        ? { id: row.id, projectId: row.project_id, path: row.path, content: row.content, version: row.version, diagramCanvas: row.diagram_canvas }
        : null
    },
    async passages(fileId) {
      const rows = await sql<Array<{ headings: string; content: string; embedding: string }>>`
        select headings, content, embedding::text as embedding from public.file_passages where file_id = ${fileId}
      `
      return rows.map((row) => ({ headings: row.headings, content: row.content, embedding: JSON.parse(row.embedding) }))
    },
    async kept(fileId) {
      const rows = await sql<Array<{ input_hash: string; embedding: string }>>`
        select input_hash, embedding::text as embedding from private.passage_embeddings where file_id = ${fileId}
      `
      return new Map(rows.map((row) => [row.input_hash, JSON.parse(row.embedding)]))
    },
    async keep(fileId, inputHash, embedding) {
      await sql`
        insert into private.passage_embeddings (file_id, input_hash, embedding)
        values (${fileId}, ${inputHash}, ${JSON.stringify(embedding)}::extensions.vector)
        on conflict do nothing
      `
    },
    async replace(file: FileRow, rows: PassageRow[], jobId: number) {
      await sql.begin(async (tx) => {
        const [current] = await tx`select version::text as version from public.project_files where id = ${file.id} for share`
        if (current?.version === file.version) {
          await tx`delete from public.file_passages where file_id = ${file.id}`
          await tx`delete from private.passage_embeddings where file_id = ${file.id}`
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
