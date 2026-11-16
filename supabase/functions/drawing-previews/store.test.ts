import { assert, assertEquals } from 'jsr:@std/assert@1.0.19'
import type postgres from 'npm:postgres@3.4.9'
import { postgresPreviewStore } from './store.ts'
import type { ClaimedDrawingPreview, StoredDrawingPreviewMetadata } from './jobs.ts'

Deno.test('the direct store calls only service queue functions with token-fenced identities and explicit PNG decoding', async () => {
  const calls: Array<{ statement: string; values: unknown[] }> = []
  const sql = Object.assign(async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const statement = parts.join('?').replace(/\s+/g, ' ').trim()
    calls.push({ statement, values })
    if (statement.includes('claim_drawing_preview_job')) return [{ job: { claimed: true } }]
    if (statement.includes('lease_current')) return [{ current: true }]
    if (statement.includes('publish_drawing_preview')) return [{ published: true }]
    if (statement.includes('fail_drawing_preview_job')) return [{ failed: true }]
    if (statement.includes('release_drawing_preview_lease')) return [{ released: true }]
    if (statement.includes('defer_drawing_preview_dispatch')) return []
    throw new Error('unexpected SQL')
  }, { json: (value: unknown) => ({ json: value }) }) as unknown as postgres.Sql
  const store = postgresPreviewStore(sql)
  const job = { file_id: 'file', generation: 8, lease_token: 'lease' } as ClaimedDrawingPreview
  const metadata = { snapshot: 'digest' } as StoredDrawingPreviewMetadata
  assertEquals(await store.claim(), { claimed: true })
  assertEquals(await store.current(job), true)
  assertEquals(await store.publish(job, 'bounded-base64', metadata), true)
  assertEquals(await store.fail(job, 'cancelled', 'Superseded.', true), true)
  assertEquals(await store.release(job), true)
  await store.deferDispatch()
  assertEquals(calls.length, 6)
  assert(calls[2].statement.includes("decode(?, 'base64')"))
  assertEquals(calls[2].values, ['file', 8, 'lease', 'bounded-base64', { json: metadata }])
  assertEquals(calls[4].values, ['file', 'lease'])
  assertEquals(calls[5], { statement: 'select public.defer_drawing_preview_dispatch(?::integer)', values: [300] })
  assert(calls.every(call => !/save_files|update public\.project_files|insert into public\.project_files/.test(call.statement)))
})
