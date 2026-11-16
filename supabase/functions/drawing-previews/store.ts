import type postgres from 'npm:postgres@3.4.9'
import type { DrawingPreviewStore } from './jobs.ts'

/** Service-only database functions own claiming, throttles and generation CAS. */
export function postgresPreviewStore(sql: postgres.Sql): DrawingPreviewStore & { deferDispatch(seconds?: number): Promise<void> } {
  return {
    async deferDispatch(seconds = 300) {
      await sql`select public.defer_drawing_preview_dispatch(${seconds}::integer)`
    },
    async claim() {
      const [row] = await sql`select public.claim_drawing_preview_job() as job`
      return row?.job ?? null
    },
    async current(job) {
      const [row] = await sql`select public.drawing_preview_lease_current(${job.file_id}::uuid,
        ${job.generation}::bigint, ${job.lease_token}::uuid) as current`
      return row?.current === true
    },
    async publish(job, png, metadata) {
      const [row] = await sql`select public.publish_drawing_preview(${job.file_id}::uuid,
        ${job.generation}::bigint, ${job.lease_token}::uuid, decode(${png}, 'base64'),
        ${sql.json(metadata as unknown as postgres.JSONValue)}::jsonb) as published`
      return row?.published === true
    },
    async fail(job, code, message, retryable) {
      const [row] = await sql`select public.fail_drawing_preview_job(${job.file_id}::uuid,
        ${job.generation}::bigint, ${job.lease_token}::uuid, ${code}::text,
        ${message}::text, ${retryable}::boolean) as failed`
      return row?.failed === true
    },
    async release(job) {
      const [row] = await sql`select public.release_drawing_preview_lease(${job.file_id}::uuid,
        ${job.lease_token}::uuid) as released`
      return row?.released === true
    },
  }
}
