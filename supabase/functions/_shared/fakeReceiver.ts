// For tests: a stand-in network whose connections lead to a fake receiver in
// memory, so the real HTTP/1.1 client in callbacks.ts is exercised without
// sockets, TLS or network permissions.

import type { Conn, Network } from './callbacks.ts'

/** A request as the receiver got it. */
export type ReceivedRequest = { requestLine: string; headers: Record<string, string>; body: string; address: string }

/** How the receiver answers: raw bytes in pieces (each one read), or 'hang' to never answer. */
export type Answer = Uint8Array[] | 'hang'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** An HTTP/1.1 answer with a Content-Length, as raw bytes in one piece. */
export function httpAnswer(status: number, body = '', headers: Record<string, string> = {}): Uint8Array[] {
  const bytes = encoder.encode(body)
  const lines = [`HTTP/1.1 ${status} X`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), `Content-Length: ${bytes.length}`, 'Connection: close']
  const head = encoder.encode(`${lines.join('\r\n')}\r\n\r\n`)
  const all = new Uint8Array(head.length + bytes.length)
  all.set(head)
  all.set(bytes, head.length)
  return [all]
}

/** An HTTP/1.1 answer with a chunked body, each chunk read separately. */
export function chunkedAnswer(status: number, chunks: string[]): Uint8Array[] {
  return [
    encoder.encode(`HTTP/1.1 ${status} OK\r\nTransfer-Encoding: chunked\r\n\r\n`),
    ...chunks.map((chunk) => encoder.encode(`${encoder.encode(chunk).length.toString(16)}\r\n${chunk}\r\n`)),
    encoder.encode('0\r\n\r\n'),
  ]
}

function parseRequest(bytes: Uint8Array, address: string): ReceivedRequest | null {
  const text = decoder.decode(bytes)
  const end = text.indexOf('\r\n\r\n')
  if (end < 0) return null
  const [requestLine, ...lines] = text.slice(0, end).split('\r\n')
  const headers = Object.fromEntries(
    lines.map((line) => [line.slice(0, line.indexOf(':')).trim().toLowerCase(), line.slice(line.indexOf(':') + 1).trim()])
  )
  const length = Number(headers['content-length'] ?? 0)
  const body = encoder.encode(text.slice(end + 4))
  if (body.length < length) return null
  return { requestLine, headers, body: decoder.decode(body.slice(0, length)), address }
}

/** A connection whose other end is `answer`. */
function receiverConn(address: string, answer: (request: ReceivedRequest) => Answer | Promise<Answer>, closed: string[]): Conn {
  let written = new Uint8Array()
  let pieces: Promise<Answer> | null = null
  let queue: Uint8Array[] | null = null
  let close!: () => void
  const closing = new Promise<never>((_, reject) => (close = () => reject(new Error('connection closed'))))
  closing.catch(() => {})
  return {
    write(data) {
      const next = new Uint8Array(written.length + data.length)
      next.set(written)
      next.set(data, written.length)
      written = next
      const request = parseRequest(written, address)
      if (request && !pieces) pieces = Promise.resolve(answer(request))
      return Promise.resolve(data.length)
    },
    async read(buffer) {
      if (!pieces) throw new Error('read before the request was written')
      if (!queue) {
        const answered = await Promise.race([pieces, closing])
        if (answered === 'hang') return await closing
        queue = answered.map((piece) => piece.slice())
      }
      const piece = queue[0]
      if (!piece) return null
      const size = Math.min(piece.length, buffer.length)
      buffer.set(piece.subarray(0, size))
      if (size === piece.length) queue.shift()
      else queue[0] = piece.subarray(size)
      return size
    },
    close() {
      closed.push(address)
      close()
    },
  }
}

export type FakeNetwork = Network & {
  /** Every address connected to, in order. */
  connected: string[]
  /** The host name each TLS session was started for. */
  tlsFor: string[]
  /** Every address whose connection was closed. */
  closed: string[]
  /** Every request the receiver got. */
  requests: ReceivedRequest[]
}

/**
 * A network where `host` resolves to `addresses` (A records, then AAAA), every
 * address is public unless `isPublic` says otherwise, and each connection is
 * answered by `answer`. `refuse` lists addresses whose connection fails, and
 * `tlsFails` makes every TLS handshake fail.
 */
export function fakeNetwork(options: {
  addresses: { A?: string[]; AAAA?: string[] }
  answer?: (request: ReceivedRequest) => Answer | Promise<Answer>
  refuse?: string[]
  tlsFails?: boolean
  isPublic?: (address: string) => boolean
}): FakeNetwork {
  const connected: string[] = []
  const tlsFor: string[] = []
  const closed: string[] = []
  const requests: ReceivedRequest[] = []
  const answer = options.answer ?? (() => httpAnswer(200))
  return {
    connected,
    tlsFor,
    closed,
    requests,
    port: 443,
    isPublic: options.isPublic ?? (() => true),
    resolve: (_host, type) => {
      const found = options.addresses[type]
      return found ? Promise.resolve(found) : Promise.reject(new Error('no records'))
    },
    connect: (address) => {
      connected.push(address)
      if (options.refuse?.includes(address)) return Promise.reject(new Error('connection refused'))
      return Promise.resolve(
        receiverConn(address, (request) => {
          requests.push(request)
          return answer(request)
        }, closed)
      )
    },
    tls: (conn, hostname) => {
      tlsFor.push(hostname)
      return options.tlsFails ? Promise.reject(new Error('certificate not valid for this name')) : Promise.resolve(conn)
    },
  }
}
