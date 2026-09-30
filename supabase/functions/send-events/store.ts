import type postgres from 'npm:postgres@3.4.9'
import type { Delivery, EventQueue, QueuedEvent } from './deliver.ts'

const QUEUE = 'comment_events'

type Message = { subscriptionId?: unknown; commentId?: unknown; eventId?: unknown }

/** The comment_events queue over a direct database connection, as the embed function reads its queue. */
export function postgresQueue(sql: postgres.Sql): EventQueue {
  return {
    async read(count, visibilitySeconds) {
      const rows = await sql<Array<{ msg_id: string; read_ct: number; message: Message }>>`
        select msg_id::text, read_ct, message from pgmq.read(${QUEUE}, ${visibilitySeconds}::integer, ${count}::integer)
      `
      const events: QueuedEvent[] = []
      for (const row of rows) {
        const { subscriptionId, commentId, eventId } = row.message ?? {}
        if (typeof subscriptionId === 'string' && typeof commentId === 'string' && typeof eventId === 'string') {
          events.push({ msgId: Number(row.msg_id), readCount: row.read_ct, subscriptionId, commentId, eventId })
        } else {
          // Not a message this function wrote: nothing can deliver it.
          await sql`select pgmq.delete(${QUEUE}, ${row.msg_id}::bigint)`
        }
      }
      return events
    },
    async delivery(event) {
      const [row] = await sql<Array<{ delivery: Delivery }>>`
        select private.comment_event_delivery(${event.subscriptionId}, ${event.commentId}::uuid) as delivery
      `
      return row?.delivery ?? { deliver: false, reason: 'no_answer' }
    },
    async finish(event) {
      await sql`select pgmq.delete(${QUEUE}, ${event.msgId}::bigint)`
    },
    async retryIn(event, seconds) {
      await sql`select pgmq.set_vt(${QUEUE}, ${event.msgId}::bigint, ${seconds}::integer)`
    },
    async giveUp(event) {
      await sql.begin(async (tx) => {
        await tx`update public.event_subscriptions set delivery_failed_at = now() where id = ${event.subscriptionId}`
        await tx`select pgmq.delete(${QUEUE}, ${event.msgId}::bigint)`
      })
    },
    async endSubscription(event) {
      await sql.begin(async (tx) => {
        await tx`delete from public.event_subscriptions where id = ${event.subscriptionId}`
        await tx`select pgmq.delete(${QUEUE}, ${event.msgId}::bigint)`
      })
    },
  }
}
