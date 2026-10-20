import { callbackPolicy, callbackProblem, denoNetwork, publicAddresses, type Conn, type Network } from './callbacks.ts'

const MAX_BYTES = 5 * 1024 * 1024
const MAX_HEADERS = 16 * 1024
const encoder = new TextEncoder(), decoder = new TextDecoder()
function fail(message: string): never { throw new Error(message) }
const close = (conn: Conn) => { try { conn.close() } catch { /* already closed */ } }

/** Explicit import only: pin each HTTPS connection to the validated public DNS answer. */
export async function importImageURL(raw: string, options: { network?: Network; deadlineMs?: number } = {}) {
  const network = options.network ?? denoNetwork
  const connections: Conn[] = []
  let expired = false
  let reject!: (error: Error) => void
  const timeout = new Promise<never>((_, no) => { reject = no })
  timeout.catch(() => {})
  const timer = setTimeout(() => {
    expired = true
    connections.forEach(close)
    reject(new Error('The image download timed out. Try another URL.'))
  }, options.deadlineMs ?? 10_000)
  const race = <T>(promise: Promise<T>) => Promise.race([promise, timeout])
  try {
    for (let redirects = 0; redirects <= 3; redirects++) {
      if (callbackProblem(raw, callbackPolicy())) fail('Use a public HTTPS image URL without credentials or a custom port.')
      const url = new URL(raw)
      url.hash = ''
      const addresses = await race(publicAddresses(url.hostname, network))
      let plain: Conn | undefined
      for (const address of addresses) {
        const opening = network.connect(address, network.port)
        opening.then(conn => { connections.push(conn); if (expired) close(conn) }, () => {})
        try { plain = await race(opening); break } catch (error) { if (expired) throw error }
      }
      if (!plain) fail('The image host could not be reached.')
      const handshake = network.tls(plain,url.hostname)
      // A timed-out handshake can still resolve with a new TLS connection.
      // Keep ownership until it resolves so that late sockets close as well.
      handshake.then(conn => { connections.push(conn); if (expired) close(conn) }, () => {})
      const secure = await race(handshake)
      try {
        const request = encoder.encode(`GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\nAccept: image/png, image/jpeg, image/webp, image/gif, image/svg+xml\r\nAccept-Encoding: identity\r\nConnection: close\r\nUser-Agent: elaborat.ing image import\r\n\r\n`)
        let sent = 0
        while (sent < request.length) {
          const written = await race(secure.write(request.subarray(sent)))
          if (!written) fail('The image host closed the connection.')
          sent += written
        }
        const reader = new BoundedReader(secure, race)
        const lines: string[] = []
        let headerBytes = 0
        for (;;) {
          const line = await reader.line(MAX_HEADERS)
          headerBytes += line.length + 2
          if (headerBytes > MAX_HEADERS) fail('The image host sent too much header data.')
          if (!line) break
          lines.push(line)
        }
        const status = /^HTTP\/1\.[01] (\d{3})(?: |$)/.exec(lines.shift() ?? '')
        if (!status) fail('The image host sent an invalid response.')
        const headers = new Map<string, string>()
        for (const line of lines) {
          const colon = line.indexOf(':')
          if (colon < 1 || /^[ \t]/.test(line)) fail('The image host sent invalid headers.')
          const name = line.slice(0, colon).toLowerCase(), value = line.slice(colon + 1).trim()
          if (headers.has(name) && ['content-length', 'transfer-encoding', 'location', 'content-type'].includes(name))
            fail('The image host sent ambiguous headers.')
          headers.set(name, value)
        }
        const code = Number(status[1])
        if ([301, 302, 303, 307, 308].includes(code)) {
          if (redirects === 3 || !headers.get('location')) fail('The image URL redirects too many times.')
          raw = new URL(headers.get('location')!, url).href
          continue
        }
        if (code !== 200) fail('The image URL could not be downloaded. Use a direct image URL.')
        if (headers.has('content-encoding') && headers.get('content-encoding') !== 'identity')
          fail('The image host sent an unsupported encoding.')
        const type = headers.get('content-type')?.split(';')[0].trim().toLowerCase()
        if (type && !['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml', 'application/octet-stream'].includes(type))
          fail('The URL must point directly to a PNG, JPEG, WebP, GIF or SVG image.')
        const length = headers.get('content-length'), transfer = headers.get('transfer-encoding')
        if (transfer && (transfer.toLowerCase() !== 'chunked' || length)) fail('The image host sent invalid framing.')
        const output = new Uint8Array(MAX_BYTES)
        let total = 0
        if (transfer) {
          for (;;) {
            const sizeLine = await reader.line(128)
            if (!/^[\da-fA-F]{1,8}(?:;[^\r\n]*)?$/.test(sizeLine)) fail('The image host sent invalid chunks.')
            const size = parseInt(sizeLine, 16)
            if (size === 0) {
              let trailerBytes = 0
              for (;;) { const line = await reader.line(MAX_HEADERS); trailerBytes += line.length + 2; if (trailerBytes > MAX_HEADERS) fail('The image response is too large.'); if (!line) break }
              break
            }
            if (total + size > MAX_BYTES) fail('Choose an image no larger than 5 MiB.')
            await reader.exact(output.subarray(total, total + size))
            total += size
            if (await reader.line(2) !== '') fail('The image host sent invalid chunks.')
          }
        } else if (length !== undefined) {
          if (!/^\d+$/.test(length) || Number(length) > MAX_BYTES) fail('Choose an image no larger than 5 MiB.')
          total = Number(length)
          await reader.exact(output.subarray(0, total))
        } else {
          for (;;) {
            const chunk = await reader.next()
            if (!chunk) break
            if (total + chunk.length > MAX_BYTES) fail('Choose an image no larger than 5 MiB.')
            output.set(chunk, total); total += chunk.length
          }
        }
        if (!total) fail('The image URL returned an empty file.')
        return { bytes: output.slice(0, total), mediaType: type }
      } finally { close(secure); close(plain) }
    }
    return fail('The image URL redirects too many times.')
  } finally { clearTimeout(timer); connections.forEach(close) }
}

class BoundedReader {
  private pending: Uint8Array = new Uint8Array()
  private received = 0
  constructor(private conn: Conn, private race: <T>(work: Promise<T>) => Promise<T>) {}
  async next(): Promise<Uint8Array | null> {
    if (this.pending.length) { const chunk = this.pending; this.pending = new Uint8Array(); return chunk }
    const buffer = new Uint8Array(16 * 1024)
    const count = await this.race(this.conn.read(buffer))
    if (count === null) return null
    if (!count) return await this.next()
    this.received += count
    if (this.received > MAX_BYTES + 128 * 1024) fail('The image response is too large.')
    return buffer.subarray(0, count)
  }
  async line(max: number): Promise<string> {
    const bytes: number[] = []
    for (;;) {
      const chunk = await this.next()
      if (!chunk) return fail('The image response ended early.')
      for (let index = 0; index < chunk.length; index++) {
        bytes.push(chunk[index])
        if (bytes.length > max + 2) fail('The image response is too large.')
        if (bytes.length >= 2 && bytes.at(-2) === 13 && bytes.at(-1) === 10) {
          this.pending = chunk.subarray(index + 1)
          return decoder.decode(new Uint8Array(bytes.slice(0, -2)))
        }
      }
    }
  }
  async exact(target: Uint8Array) {
    let offset = 0
    while (offset < target.length) {
      const chunk = await this.next()
      if (!chunk) fail('The image response ended early.')
      const count = Math.min(chunk.length, target.length - offset)
      target.set(chunk.subarray(0, count), offset); offset += count
      this.pending = chunk.subarray(count)
    }
  }
}
