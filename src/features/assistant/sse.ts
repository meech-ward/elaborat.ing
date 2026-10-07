/**
 * A small server-sent events reader for the Responses stream: each event's
 * `data` as parsed JSON, whatever the chunks' boundaries (a line, a field or
 * a character split across two reads). `[DONE]` and data that is not JSON
 * are skipped.
 */
export function eventParser(): { push(text: string, end?: boolean): unknown[] } {
  let buffer = ""
  let data: string[] = []
  const dispatch = (events: unknown[]) => {
    if (data.length === 0) return
    const text = data.join("\n")
    data = []
    if (text === "[DONE]") return
    try {
      events.push(JSON.parse(text))
    } catch {
      // Not JSON: nothing the reader understands.
    }
  }
  const line = (text: string, events: unknown[]) => {
    if (text === "") return dispatch(events)
    if (text.startsWith(":")) return
    const colon = text.indexOf(":")
    const field = colon === -1 ? text : text.slice(0, colon)
    let value = colon === -1 ? "" : text.slice(colon + 1)
    if (value.startsWith(" ")) value = value.slice(1)
    if (field === "data") data.push(value)
  }
  return {
    push(text, end = false) {
      buffer += text
      const events: unknown[] = []
      for (;;) {
        const match = /\r\n|\r|\n/.exec(buffer)
        if (!match) break
        // A carriage return at the very end may be the first half of \r\n.
        if (match[0] === "\r" && match.index === buffer.length - 1 && !end) break
        line(buffer.slice(0, match.index), events)
        buffer = buffer.slice(match.index + match[0].length)
      }
      if (end) {
        if (buffer) line(buffer, events)
        buffer = ""
        dispatch(events)
      }
      return events
    },
  }
}

/** The events of a response body, as they arrive. */
export async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const parser = eventParser()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      const events = done ? parser.push(decoder.decode(), true) : parser.push(decoder.decode(value, { stream: true }))
      for (const event of events) if (event && typeof event === "object") yield event as Record<string, unknown>
      if (done) return
    }
  } finally {
    // Stopped early (Stop, or the reader went away): let the stream go.
    void reader.cancel().catch(() => {})
  }
}
