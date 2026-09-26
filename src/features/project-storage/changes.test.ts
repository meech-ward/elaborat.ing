import { expect, test } from "bun:test"
import { REALTIME_SUBSCRIBE_STATES, type SupabaseClient } from "@supabase/supabase-js"
import { ProjectChanges } from "./changes"

const PROJECT = "0f8e7d6c-5b4a-4392-8a1b-0c9d8e7f6a5b"

type Message = { type: "broadcast"; event: string; payload?: unknown }
type StatusCallback = (status: REALTIME_SUBSCRIBE_STATES, error?: Error) => void

/** Stands in for a Realtime channel: records what the class asks for and delivers messages on demand. */
class FakeChannel {
  bindings: { type: string; event: string; callback: (message: Message) => void }[] = []
  subscribed = false
  status: StatusCallback | undefined

  constructor(readonly topic: string, readonly options: unknown) {}

  on(type: string, filter: { event: string }, callback: (message: Message) => void) {
    this.bindings.push({ type, event: filter.event, callback })
    return this
  }

  subscribe(callback?: StatusCallback) {
    this.subscribed = true
    this.status = callback
    return this
  }

  /** A broadcast arriving from the server. */
  deliver(event: string, payload?: unknown) {
    for (const binding of this.bindings) {
      if (binding.type === "broadcast" && binding.event === event) binding.callback({ type: "broadcast", event, payload })
    }
  }
}

function realtime() {
  const channels: FakeChannel[] = []
  const removed: FakeChannel[] = []
  const client = {
    channel: (topic: string, options: unknown) => {
      const channel = new FakeChannel(topic, options)
      channels.push(channel)
      return channel
    },
    removeChannel: async (channel: FakeChannel) => {
      removed.push(channel)
      return "ok" as const
    },
  }
  return { client: client as unknown as Pick<SupabaseClient, "channel" | "removeChannel">, channels, removed }
}

test("joins the project's private channel and listens for changed broadcasts", () => {
  const { client, channels } = realtime()
  new ProjectChanges(client, PROJECT, 0, () => {})

  expect(channels).toHaveLength(1)
  expect(channels[0].topic).toBe(`project:${PROJECT}`)
  expect(channels[0].options).toEqual({ config: { private: true } })
  expect(channels[0].subscribed).toBe(true)
  expect(channels[0].bindings.map(({ type, event }) => ({ type, event }))).toEqual([{ type: "broadcast", event: "changed" }])
})

test("announces each newer revision once and ignores older, repeated and malformed signals", () => {
  const { client, channels } = realtime()
  const announced: number[] = []
  new ProjectChanges(client, PROJECT, 3, (revision) => announced.push(revision))
  const channel = channels[0]

  channel.deliver("changed", { revision: 2 })
  channel.deliver("changed", { revision: 3 })
  channel.deliver("changed", { revision: 4 })
  channel.deliver("changed", { revision: 4 })
  // Realtime adds its own message id to every payload.
  channel.deliver("changed", { revision: 6, id: "5a0c3e2e-8f0a-4d7b-9c1e-2b3a4c5d6e7f" })
  channel.deliver("changed", { revision: 5 })
  for (const payload of [undefined, null, {}, { revision: "7" }, { revision: 7.5 }, { revision: -7 }, { revision: 0 }]) {
    channel.deliver("changed", payload)
  }
  channel.deliver("other", { revision: 9 })

  expect(announced).toEqual([4, 6])
})

test("a revision the device already has, such as from its own save, is not announced", () => {
  const { client, channels } = realtime()
  const announced: number[] = []
  const changes = new ProjectChanges(client, PROJECT, 1, (revision) => announced.push(revision))
  const channel = channels[0]

  changes.seen(2)
  channel.deliver("changed", { revision: 2 })
  changes.seen(1)
  channel.deliver("changed", { revision: 2 })
  channel.deliver("changed", { revision: 3 })

  expect(announced).toEqual([3])
})

test("reports the channel's status as Realtime gives it", () => {
  const { client, channels } = realtime()
  const statuses: [REALTIME_SUBSCRIBE_STATES, string | undefined][] = []
  new ProjectChanges(client, PROJECT, 0, () => {}, (status, error) => statuses.push([status, error?.message]))

  channels[0].status?.(REALTIME_SUBSCRIBE_STATES.SUBSCRIBED)
  channels[0].status?.(REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR, new Error("Unauthorized"))

  expect(statuses).toEqual([
    [REALTIME_SUBSCRIBE_STATES.SUBSCRIBED, undefined],
    [REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR, "Unauthorized"],
  ])
})

test("close leaves the channel once, and nothing is announced after it", async () => {
  const { client, channels, removed } = realtime()
  const announced: number[] = []
  const changes = new ProjectChanges(client, PROJECT, 0, (revision) => announced.push(revision))

  await changes.close()
  await changes.close()
  channels[0].deliver("changed", { revision: 1 })

  expect(removed).toEqual([channels[0]])
  expect(announced).toEqual([])
})
