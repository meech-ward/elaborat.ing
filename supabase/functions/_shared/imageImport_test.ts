import { deepEqual, equal, rejects } from 'node:assert/strict'
import { importImageURL } from './imageImport.ts'
import { isPublic, type Conn, type Network } from './callbacks.ts'

const text = new TextEncoder()
function network(responses: string[], addresses = ['93.184.216.34']) {
  const writes: string[] = [], pins: string[] = [], names: string[] = []
  let count = 0, closed = 0
  const net: Network = {
    port: 443, isPublic,
    resolve: async (_host, type) => type === 'A' ? addresses : [],
    connect: async address => {
      pins.push(address)
      const response = text.encode(responses[count++] ?? '')
      let offset = 0
      const conn: Conn = {
        write: async bytes => { writes.push(new TextDecoder().decode(bytes)); return bytes.length },
        read: async target => {
          if (offset === response.length) return null
          const length = Math.min(target.length, 17, response.length - offset)
          target.set(response.subarray(offset, offset + length)); offset += length
          return length
        },
        close: () => { closed++ },
      }
      return conn
    },
    tls: async (conn, hostname) => { names.push(hostname); return conn },
  }
  return { net, writes, pins, names, closed: () => closed }
}
const good = 'HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: 3\r\n\r\nabc'
Deno.test('import pins DNS with TLS hostname and sends no ambient credentials', async () => {
  const mock = network([good])
  const imported = await importImageURL('https://images.example.com/photo.png?version=2', { network: mock.net })
  equal(new TextDecoder().decode(imported.bytes), 'abc')
  equal(imported.mediaType, 'image/png')
  deepEqual(mock.pins, ['93.184.216.34'])
  deepEqual(mock.names, ['images.example.com'])
  const request = mock.writes.join('')
  equal(request.startsWith('GET /photo.png?version=2 HTTP/1.1\r\nHost: images.example.com\r\n'), true)
  equal(/authorization|cookie|referer/i.test(request), false)
  equal(mock.closed() > 0, true)
})
Deno.test('chunked and close-delimited responses remain bounded', async () => {
  const chunked = network(['HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nab\r\n1\r\nc\r\n0\r\n\r\n'])
  equal(new TextDecoder().decode((await importImageURL('https://images.example.com/a', { network: chunked.net })).bytes), 'abc')
  const ended = network(['HTTP/1.0 200 OK\r\n\r\nabc'])
  equal((await importImageURL('https://images.example.com/a', { network: ended.net })).bytes.length, 3)
})
Deno.test('every redirect gets fresh public DNS validation and TLS pinning', async () => {
  const mock = network(['HTTP/1.1 302 Found\r\nLocation: https://cdn.example.net/a.png\r\n\r\n', good])
  await importImageURL('https://images.example.com/a', { network: mock.net })
  deepEqual(mock.names, ['images.example.com', 'cdn.example.net'])
  const privateHop = network(['HTTP/1.1 302 Found\r\nLocation: https://127.0.0.1/a.png\r\n\r\n'])
  await rejects(() => importImageURL('https://images.example.com/a', { network: privateHop.net }))
  equal(privateHop.pins.length, 1)
})
Deno.test('refuses private or mixed DNS, credentials, ports, IP spellings and local names', async () => {
  for (const url of ['http://images.example.com/a', 'https://a:b@images.example.com/a', 'https://images.example.com:8443/a', 'https://0x7f000001/a', 'https://host.internal/a', 'https://elaborat.ing/a']) {
    const mock = network([good])
    await rejects(() => importImageURL(url, { network: mock.net }))
    equal(mock.pins.length, 0)
  }
  for (const addresses of [['10.0.0.1'], ['93.184.216.34', '169.254.169.254'], ['::ffff:127.0.0.1']]) {
    const mock = network([good], addresses)
    await rejects(() => importImageURL('https://images.example.com/a', { network: mock.net }))
    equal(mock.pins.length, 0)
  }
})
Deno.test('refuses oversized, compressed, ambiguous, incomplete and non-image answers', async () => {
  for (const response of [
    'HTTP/1.1 200 OK\r\nContent-Length: 5242881\r\n\r\n',
    'HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\nabc',
    'HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\n\r\nabc',
    'HTTP/1.1 200 OK\r\nContent-Length: 3\r\nContent-Length: 4\r\n\r\nabc',
    'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Length: 3\r\n\r\nabc',
    'HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nabc',
    'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nq\r\na\r\n',
    'HTTP/1.1 403 Forbidden\r\n\r\n',
  ]) {
    const mock = network([response])
    await rejects(() => importImageURL('https://images.example.com/a', { network: mock.net }))
    equal(mock.closed() > 0, true)
  }
})
Deno.test('redirect count and one overall deadline are enforced', async () => {
  const redirect = 'HTTP/1.1 302 Found\r\nLocation: /again\r\n\r\n'
  const mock = network([redirect, redirect, redirect, redirect])
  await rejects(() => importImageURL('https://images.example.com/a', { network: mock.net }), /redirects/)
  equal(mock.pins.length, 4)
  const stalled = network([good])
  stalled.net.resolve = () => new Promise(() => {})
  await rejects(() => importImageURL('https://images.example.com/a', { network: stalled.net, deadlineMs: 5 }), /timed out/)
})

Deno.test('a TLS connection resolving after the deadline is still closed', async () => {
  const mock = network([good])
  let finish!: (conn:Conn)=>void
  let lateClosed = 0
  mock.net.tls = () => new Promise(resolve => {finish=resolve})
  await rejects(() => importImageURL('https://images.example.com/a', {network:mock.net,deadlineMs:5}),/timed out/)
  finish({write:async bytes=>bytes.length,read:async()=>null,close:()=>{lateClosed++}})
  await Promise.resolve()
  equal(lateClosed,1)
})
