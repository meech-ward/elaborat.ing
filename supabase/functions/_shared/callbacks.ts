// Posting to an address someone else chose, such as an MCP Events callback.
//
// The address is checked twice: its URL before anything is sent (https on
// port 443, a host name rather than an IP address, not one of this app's own
// hosts, and on the allowlist when one is set), then every address its name
// resolves to, on every delivery. Only public addresses pass, and if any
// address of the name is not public the name is refused. The request then
// goes to the checked address itself, with TLS verified against the host
// name, so a second DNS answer can never send it somewhere else. It is one
// HTTP/1.1 POST: redirects are not followed (a 3xx is an answer like any
// other, and callers treat it as a failure), one deadline covers the whole
// exchange, and at most 64 KiB of the answer is read.
//
// Plain `fetch` cannot connect to an address it did not resolve itself, so
// this uses Deno.connect and Deno.startTls, which the Edge Runtime supports.

/** The whole exchange (resolving, connecting, TLS, sending and reading), at most. */
export const CALLBACK_DEADLINE_MS = 10_000
/** Bytes of an answer read at most, headers included. */
export const MAX_RESPONSE_BYTES = 64 * 1024
/** Longest callback URL accepted. */
const MAX_URL_LENGTH = 2048

/** The app's own host names: never a callback. */
const APP_HOSTS = ['elaborat.ing']
/** Names that only mean something inside a network. */
const LOCAL_SUFFIXES = /(^|\.)(localhost|local|localdomain|internal|intranet|home|lan|corp|private|arpa)$/

/** Why a callback cannot be reached or was refused. */
export type CallbackFailure =
  | 'not_a_url'
  | 'not_https'
  | 'has_credentials'
  | 'port_not_allowed'
  | 'ip_address'
  | 'local_host'
  | 'own_host'
  | 'host_not_allowed'
  | 'unresolvable'
  | 'private_address'
  | 'unreachable'
  | 'tls_failed'
  | 'timeout'
  | 'bad_response'
  | 'response_too_large'

export class CallbackError extends Error {
  constructor(readonly reason: CallbackFailure) {
    super(`Callback failed: ${reason}`)
    this.name = 'CallbackError'
  }
}

/**
 * Which hosts may be called. `allowedHosts` is null when any public host may
 * be; otherwise only those listed (an entry `*.example.com` covers its
 * subdomains). `ownHosts` are never called, subdomains included.
 */
export type CallbackPolicy = { ownHosts: string[]; allowedHosts: string[] | null }

function readEnv(name: string): string | undefined {
  try {
    return Deno.env.get(name)
  } catch {
    return undefined
  }
}

/**
 * The policy from the environment: the app's hosts and this project's own
 * Supabase host are refused, and `MCP_EVENTS_CALLBACK_HOSTS`, when set, is a
 * comma-separated allowlist. Setting it to `none` stops every callback.
 */
export function callbackPolicy(): CallbackPolicy {
  const ownHosts = [...APP_HOSTS]
  const projectUrl = readEnv('SUPABASE_URL')
  if (projectUrl) {
    try {
      ownHosts.push(new URL(projectUrl).hostname.toLowerCase())
    } catch {
      // Not a URL: nothing more to refuse.
    }
  }
  const allowed = readEnv('MCP_EVENTS_CALLBACK_HOSTS')
  return {
    ownHosts,
    allowedHosts: allowed === undefined ? null : allowed.split(',').map((host) => host.trim().toLowerCase()).filter(Boolean),
  }
}

const coveredBy = (host: string, parent: string) => host === parent || host.endsWith(`.${parent}`)

function allowedBy(host: string, entry: string): boolean {
  return entry.startsWith('*.') ? host.endsWith(entry.slice(1)) : host === entry
}

/** Why this URL may not be called, or null when it may (its addresses are checked when it is). */
export function callbackProblem(raw: string, policy: CallbackPolicy = callbackPolicy()): CallbackFailure | null {
  if (raw.length > MAX_URL_LENGTH) return 'not_a_url'
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return 'not_a_url'
  }
  if (url.protocol !== 'https:') return 'not_https'
  if (url.username || url.password) return 'has_credentials'
  // URL drops the scheme's default port, so any port left is another one.
  if (url.port) return 'port_not_allowed'
  // URL writes every IPv4 spelling (hex, octal, short forms) as dotted decimal.
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (host.startsWith('[') || /^[\d.]+$/.test(host)) return 'ip_address'
  if (!host.includes('.') || LOCAL_SUFFIXES.test(host)) return 'local_host'
  if (policy.ownHosts.some((own) => coveredBy(host, own))) return 'own_host'
  if (policy.allowedHosts && !policy.allowedHosts.some((entry) => allowedBy(host, entry))) return 'host_not_allowed'
  return null
}

// IPv4 ranges that are not the public internet (IANA special-purpose
// registry): this network, private, shared, loopback, link-local, protocol
// assignments, documentation, 6to4 relay, benchmarking, multicast, reserved.
const IPV4_BLOCKED: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]

function ipv4Number(address: string): number | null {
  const parts = address.split('.')
  if (parts.length !== 4 || !parts.every((part) => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255)) return null
  return parts.reduce((value, part) => value * 256 + Number(part), 0)
}

const IPV4_BLOCKED_RANGES = IPV4_BLOCKED.map(([base, bits]) => {
  const size = 2 ** (32 - bits)
  return { start: ipv4Number(base)!, size }
})

/** The eight 16-bit groups of an IPv6 address, or null when it is not one. */
function ipv6Groups(address: string): number[] | null {
  let text = address.toLowerCase()
  if (!text.includes(':') || text.includes('%')) return null
  let tail: number[] = []
  const lastColon = text.lastIndexOf(':')
  const last = text.slice(lastColon + 1)
  if (last.includes('.')) {
    // An IPv4 address as the last two groups, such as ::ffff:10.0.0.1.
    const v4 = ipv4Number(last)
    if (v4 === null) return null
    tail = [Math.floor(v4 / 65536), v4 % 65536]
    text = text.slice(0, lastColon + 1)
    if (!text.endsWith('::')) text = text.slice(0, -1)
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const parse = (part: string) => (part === '' ? [] : part.split(':'))
  const head = parse(halves[0])
  const rest = halves.length === 2 ? parse(halves[1]) : []
  if (![...head, ...rest].every((group) => /^[0-9a-f]{1,4}$/.test(group))) return null
  const known = head.length + rest.length + tail.length
  if (halves.length === 1 ? known !== 8 : known > 7) return null
  const zeros = new Array(8 - known).fill(0)
  return [...head.map((g) => parseInt(g, 16)), ...zeros, ...rest.map((g) => parseInt(g, 16)), ...tail]
}

/**
 * Whether an address, as DNS returns it, is on the public internet. IPv4
 * outside the blocked ranges; IPv6 only in global unicast (2000::/3), less the
 * protocol assignments (2001::/23, Teredo among them), documentation
 * (2001:db8::/32 and 3fff::/20) and 6to4 (2002::/16). Anything else, IPv4
 * written inside IPv6 included, is not.
 */
export function isPublic(address: string): boolean {
  const v4 = ipv4Number(address)
  if (v4 !== null) return !IPV4_BLOCKED_RANGES.some(({ start, size }) => v4 >= start && v4 < start + size)
  const groups = ipv6Groups(address)
  if (!groups) return false
  const [first, second] = groups
  if ((first & 0xe000) !== 0x2000) return false
  if (first === 0x2001 && second < 0x0200) return false
  if (first === 0x2001 && second === 0x0db8) return false
  if (first === 0x2002) return false
  if (first === 0x3fff && second < 0x1000) return false
  return true
}

/** A connection, as much of Deno.Conn as this uses. */
export type Conn = {
  read(buffer: Uint8Array): Promise<number | null>
  write(data: Uint8Array): Promise<number>
  close(): void
}

/** The network: Deno's, or a stand-in in tests. */
export type Network = {
  resolve(host: string, type: 'A' | 'AAAA'): Promise<string[]>
  connect(address: string, port: number): Promise<Conn>
  tls(conn: Conn, hostname: string): Promise<Conn>
  port: number
  isPublic(address: string): boolean
}

export const denoNetwork: Network = {
  resolve: (host, type) => Deno.resolveDns(host, type),
  connect: (address, port) => Deno.connect({ hostname: address, port, transport: 'tcp' }),
  tls: (conn, hostname) => Deno.startTls(conn as Deno.TcpConn, { hostname }),
  port: 443,
  isPublic,
}

/** Every address the host resolves to, when all of them are public. */
export async function publicAddresses(host: string, network: Network): Promise<string[]> {
  const answers = await Promise.allSettled([network.resolve(host, 'A'), network.resolve(host, 'AAAA')])
  const addresses = answers.flatMap((answer) => (answer.status === 'fulfilled' ? answer.value : []))
  if (addresses.length === 0) throw new CallbackError('unresolvable')
  if (!addresses.every((address) => network.isPublic(address))) throw new CallbackError('private_address')
  return addresses
}

/** A callback's answer: its status and up to 64 KiB of its body, as text. */
export type CallbackResponse = { status: number; body: string }

/** Posts a body to a callback URL; how events are delivered and callbacks verified. */
export type Post = (url: string, headers: Record<string, string>, body: string) => Promise<CallbackResponse>

type Deadline = { race<T>(work: Promise<T>): Promise<T>; onExpire(close: () => void): void; clear(): void }

function deadline(ms: number): Deadline {
  const closers: (() => void)[] = []
  let fired = false
  let expired!: (error: CallbackError) => void
  const signal = new Promise<never>((_, reject) => (expired = reject))
  signal.catch(() => {})
  const timer = setTimeout(() => {
    fired = true
    expired(new CallbackError('timeout'))
    for (const close of closers) close()
  }, ms)
  return {
    race: (work) => Promise.race([work, signal]),
    // Something opened after the deadline is closed at once.
    onExpire: (close) => (fired ? close() : closers.push(close)),
    clear: () => clearTimeout(timer),
  }
}

function closeQuietly(conn: Conn): void {
  try {
    conn.close()
  } catch {
    // Already closed.
  }
}

async function writeAll(conn: Conn, data: Uint8Array): Promise<void> {
  let written = 0
  while (written < data.length) written += await conn.write(data.subarray(written))
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function indexOf(bytes: Uint8Array, pattern: number[], from = 0): number {
  outer: for (let i = from; i <= bytes.length - pattern.length; i++) {
    for (let j = 0; j < pattern.length; j++) if (bytes[i + j] !== pattern[j]) continue outer
    return i
  }
  return -1
}

const CRLF = [13, 10]
const HEADER_END = [13, 10, 13, 10]

type Parsed = { status: number; body: Uint8Array; complete: boolean }

/** Decodes a chunked body as far as it goes. */
function dechunk(bytes: Uint8Array): { body: Uint8Array; complete: boolean } {
  const parts: Uint8Array[] = []
  let at = 0
  for (;;) {
    const lineEnd = indexOf(bytes, CRLF, at)
    if (lineEnd < 0) break
    const size = parseInt(decoder.decode(bytes.subarray(at, lineEnd)).split(';')[0].trim(), 16)
    if (!Number.isFinite(size) || size < 0) throw new CallbackError('bad_response')
    if (size === 0) return { body: concat(parts), complete: true }
    const start = lineEnd + 2
    parts.push(bytes.subarray(start, Math.min(start + size, bytes.length)))
    if (start + size + 2 > bytes.length) break
    at = start + size + 2
  }
  return { body: concat(parts), complete: false }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** Parses what has arrived of an HTTP/1.1 answer, or null while the headers are still coming. */
function parseResponse(bytes: Uint8Array, ended: boolean): Parsed | null {
  const headerEnd = indexOf(bytes, HEADER_END)
  if (headerEnd < 0) return null
  const [statusLine, ...lines] = decoder.decode(bytes.subarray(0, headerEnd)).split('\r\n')
  const match = /^HTTP\/1\.[01] (\d{3})(?: |$)/.exec(statusLine)
  if (!match) throw new CallbackError('bad_response')
  const headers = new Map(
    lines.map((line) => {
      const colon = line.indexOf(':')
      return [line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()] as const
    })
  )
  const rest = bytes.subarray(headerEnd + 4)
  const status = Number(match[1])
  if (/\bchunked\b/i.test(headers.get('transfer-encoding') ?? '')) return { status, ...dechunk(rest) }
  const length = headers.get('content-length')
  if (length !== undefined) {
    const size = Number(length)
    if (!Number.isInteger(size) || size < 0) throw new CallbackError('bad_response')
    return { status, body: rest.subarray(0, size), complete: rest.length >= size }
  }
  if (status === 204 || status === 304) return { status, body: new Uint8Array(), complete: true }
  return { status, body: rest, complete: ended }
}

/** One HTTP/1.1 POST over an open connection, and its answer. */
async function exchange(conn: Conn, url: URL, headers: Record<string, string>, body: string, race: Deadline['race']): Promise<CallbackResponse> {
  const payload = encoder.encode(body)
  const lines = [
    `POST ${url.pathname}${url.search} HTTP/1.1`,
    `Host: ${url.host}`,
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    `Content-Length: ${payload.length}`,
    'Connection: close',
    'User-Agent: elaborat.ing',
  ]
  if (lines.some((line) => /[\r\n]/.test(line))) throw new TypeError('A header holds a line break')
  await race(writeAll(conn, concat([encoder.encode(`${lines.join('\r\n')}\r\n\r\n`), payload])))

  const received: Uint8Array[] = []
  let size = 0
  const buffer = new Uint8Array(16 * 1024)
  for (;;) {
    const read = await race(conn.read(buffer))
    const ended = read === null
    if (!ended) {
      received.push(buffer.slice(0, read))
      size += read
    }
    const bytes = concat(received)
    const parsed = parseResponse(bytes.subarray(0, MAX_RESPONSE_BYTES), ended)
    if (parsed && (parsed.complete || ended || size >= MAX_RESPONSE_BYTES)) {
      return { status: parsed.status, body: decoder.decode(parsed.body) }
    }
    if (!parsed && size >= MAX_RESPONSE_BYTES) throw new CallbackError('response_too_large')
    if (ended) throw new CallbackError('bad_response')
  }
}

/**
 * POSTs `body` to a callback URL and returns its answer, or throws a
 * CallbackError saying why it could not. The URL and every address are
 * checked each time, since DNS answers change. Only a failed connection moves
 * on to the host's next address.
 */
export async function postToCallback(
  raw: string,
  headers: Record<string, string>,
  body: string,
  options: { policy?: CallbackPolicy; network?: Network; deadlineMs?: number } = {}
): Promise<CallbackResponse> {
  const problem = callbackProblem(raw, options.policy ?? callbackPolicy())
  if (problem) throw new CallbackError(problem)
  const url = new URL(raw)
  const network = options.network ?? denoNetwork
  const timer = deadline(options.deadlineMs ?? CALLBACK_DEADLINE_MS)
  try {
    const addresses = await timer.race(publicAddresses(url.hostname, network))
    let conn: Conn | null = null
    for (const address of addresses) {
      const connecting = network.connect(address, network.port)
      // A connection that opens after the deadline is closed as it opens.
      connecting.then((opened) => timer.onExpire(() => closeQuietly(opened)), () => {})
      try {
        conn = await timer.race(connecting)
        break
      } catch (error) {
        if (error instanceof CallbackError) throw error
      }
    }
    if (!conn) throw new CallbackError('unreachable')
    const plain = conn
    timer.onExpire(() => closeQuietly(plain))
    let secure: Conn
    try {
      secure = await timer.race(network.tls(plain, url.hostname))
    } catch (error) {
      closeQuietly(plain)
      throw error instanceof CallbackError ? error : new CallbackError('tls_failed')
    }
    timer.onExpire(() => closeQuietly(secure))
    try {
      return await exchange(secure, url, headers, body, timer.race)
    } catch (error) {
      if (error instanceof CallbackError || error instanceof TypeError) throw error
      throw new CallbackError('unreachable')
    } finally {
      closeQuietly(secure)
    }
  } finally {
    timer.clear()
  }
}
