import { assertEquals } from 'jsr:@std/assert@1.0.19'
import {
  cleanupImages,
  type ImageDeps,
  importImageRequest,
  MAX_IMAGE_BYTES,
  storeImage,
  uploadImageRequest,
  type ValidatedImage,
} from './handler.ts'

const projectId = 'aaaaaaaa-0000-4000-8000-000000000001'
const assetId = 'bbbbbbbb-0000-4000-8000-000000000001'
const userId = '11111111-1111-4111-8111-111111111111'
const identity = { projectId, assetId, userId }
const bytes = new Uint8Array([1, 2, 3])
const image: ValidatedImage = {
  mediaType: 'image/png',
  width: 2,
  height: 3,
  sha256: 'a'.repeat(64),
  byteLength: bytes.length,
  thumbnail: new Uint8Array([4, 5]),
  thumbnailType: 'image/png',
}
function fake() {
  const objects = new Map<string, Uint8Array>()
  const calls: string[] = []
  const deps: ImageDeps = {
    validate: async () => {
      calls.push('validate')
      return image
    },
    reserve: async () => {
      calls.push('reserve')
      return { data: {}, error: null }
    },
    complete: async () => {
      calls.push('complete')
      return { data: {}, error: null }
    },
    upload: async (key, body) => {
      calls.push(`upload:${key}`)
      if (objects.has(key)) return { error: { message: 'already exists' } }
      objects.set(key, body.slice())
      return { error: null }
    },
    download: async (key) => objects.get(key) ?? null,
  }
  return { objects, calls, deps }
}
Deno.test('uploads validated originals and bounded previews before completing', async () => {
  const f = fake()
  const response = await storeImage(bytes, 'image/png', identity, f.deps)
  assertEquals(response.status, 200)
  const { asset } = await response.json()
  assertEquals(asset, {
    id: assetId,
    media_type: 'image/png',
    byte_length: 3,
    width: 2,
    height: 3,
    sha256: 'a'.repeat(64),
    object_key: `${projectId}/${assetId}/original`,
    preview_key: `${projectId}/${assetId}/preview`,
    preview_type: 'image/png',
    preview_byte_length: 2,
  })
  assertEquals(f.calls, [
    'validate',
    'reserve',
    `upload:${projectId}/${assetId}/original`,
    `upload:${projectId}/${assetId}/preview`,
    'complete',
  ])
})
Deno.test('lost response retries use exact immutable bytes and the same identity', async () => {
  const f = fake()
  assertEquals(
    (await storeImage(bytes, 'image/png', identity, f.deps)).status,
    200,
  )
  assertEquals(
    (await storeImage(bytes, 'image/png', identity, f.deps)).status,
    200,
  )
  assertEquals(f.objects.size, 2)
})
Deno.test('a foreign immutable object is never overwritten or committed', async () => {
  const f = fake()
  f.objects.set(`${projectId}/${assetId}/original`, new Uint8Array([9, 9, 9]))
  assertEquals(
    (await storeImage(bytes, 'image/png', identity, f.deps)).status,
    502,
  )
  assertEquals(f.calls.includes('complete'), false)
  assertEquals(
    f.objects.get(`${projectId}/${assetId}/original`),
    new Uint8Array([9, 9, 9]),
  )
})
Deno.test('corrupt or spoofed images are refused before reservation and upload', async () => {
  const f = fake()
  f.deps.validate = async () => {
    throw new Error('Image type does not match its bytes')
  }
  const response = await storeImage(bytes, 'image/jpeg', identity, f.deps)
  assertEquals(response.status, 400)
  assertEquals(
    (await response.json()).error,
    'Image type does not match its bytes',
  )
  assertEquals(f.objects.size, 0)
  assertEquals(f.calls, [])
})
Deno.test('size and preview limits are enforced independently of decoder', async () => {
  const f = fake()
  assertEquals(
    (await storeImage(
      new Uint8Array(MAX_IMAGE_BYTES + 1),
      'image/png',
      identity,
      f.deps,
    )).status,
    413,
  )
  assertEquals(f.calls, [])
  f.deps.validate = async () => ({ ...image, thumbnail: new Uint8Array(32769) })
  assertEquals(
    (await storeImage(bytes, 'image/png', identity, f.deps)).status,
    400,
  )
  assertEquals(f.objects.size, 0)
})
Deno.test('quota, access and lost-ready errors retain the draft and refuse commit', async () => {
  for (
    const [code, status] of [['54000', 413], ['42501', 403], ['55000', 409], [
      'PT429',
      429,
    ]] as const
  ) {
    const f = fake()
    f.deps.reserve = async () => ({
      data: null,
      error: { code, message: 'refused' },
    })
    assertEquals(
      (await storeImage(bytes, 'image/png', identity, f.deps)).status,
      status,
    )
    assertEquals(f.objects.size, 0)
  }
  const f = fake()
  f.deps.complete = async () => ({
    data: null,
    error: { code: '55000', message: 'missing' },
  })
  assertEquals(
    (await storeImage(bytes, 'image/png', identity, f.deps)).status,
    409,
  )
  assertEquals(f.objects.size, 2)
})
Deno.test('missing preview upload never acknowledges a ready image', async () => {
  const f = fake()
  const normal = f.deps.upload
  f.deps.upload = async (key, body, type) =>
    key.endsWith('/preview')
      ? { error: { message: 'network unavailable' } }
      : await normal(key, body, type)
  assertEquals(
    (await storeImage(bytes, 'image/png', identity, f.deps)).status,
    502,
  )
  assertEquals(f.calls.includes('complete'), false)
})
Deno.test('raw binary endpoint bounds streamed input and validates ids before reading', async () => {
  const f = fake()
  const target =
    `https://example.com/images?project_id=${projectId}&asset_id=${assetId}`
  assertEquals(
    (await uploadImageRequest(
      new Request(target, {
        method: 'POST',
        body: bytes,
        headers: { 'content-type': 'image/png' },
      }),
      userId,
      f.deps,
    )).status,
    200,
  )
  assertEquals(
    (await uploadImageRequest(
      new Request('https://example.com/images?project_id=bad', {
        method: 'POST',
        body: bytes,
      }),
      userId,
      f.deps,
    )).status,
    400,
  )
  assertEquals(
    (await uploadImageRequest(
      new Request(target, {
        method: 'POST',
        body: new Uint8Array(MAX_IMAGE_BYTES + 1),
      }),
      userId,
      f.deps,
    )).status,
    413,
  )
})
Deno.test('durable cleanup confirms the queue only after Storage deletion', async () => {
  const calls: string[] = []
  const deps = {
    claim: async () => ({ data: ['key'], error: null }),
    remove: async () => {
      calls.push('remove')
      return { error: { message: 'retry' } as { message: string } | null }
    },
    finish: async () => {
      calls.push('finish')
      return { error: null }
    },
  }
  assertEquals((await cleanupImages(deps)).status, 502)
  assertEquals(calls, ['remove'])
  deps.remove = async () => {
    calls.push('remove')
    return { error: null }
  }
  assertEquals((await cleanupImages(deps)).status, 200)
  assertEquals(calls, ['remove', 'remove', 'finish'])
})

Deno.test('URL import validates a bounded explicit request and uses the same upload pipeline', async () => {
  const f = fake()
  const imports: string[] = []
  const deps = {
    ...f.deps,
    readExisting: async () => ({ data: null, error: null }),
    importURL: async (url: string) => {
      imports.push(url)
      return { bytes, mediaType: 'image/png' }
    },
  }
  const target = `https://example.com/images?project_id=${projectId}&import=1`
  const request = (body: unknown) =>
    new Request(target, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    })
  assertEquals(
    (await importImageRequest(
      request({
        url: 'https://images.example.com/photo.png',
        asset_id: assetId,
      }),
      userId,
      deps,
    )).status,
    200,
  )
  assertEquals(imports, ['https://images.example.com/photo.png'])
  assertEquals(f.objects.size, 2)
  assertEquals(
    (await importImageRequest(
      request({ url: '', asset_id: assetId }),
      userId,
      deps,
    )).status,
    400,
  )
  assertEquals(
    (await importImageRequest(
      request({
        url: 'https://example.com/' + 'a'.repeat(5000),
        asset_id: assetId,
      }),
      userId,
      deps,
    )).status,
    400,
  )
  assertEquals(imports.length, 1)
})
Deno.test('lost URL-import answers return the saved asset without another external request', async () => {
  const f = fake()
  const asset = { id: assetId, media_type: 'image/png' }
  const response = await importImageRequest(
    new Request(`https://example.com/images?project_id=${projectId}&import=1`, {
      method: 'POST',
      body: JSON.stringify({
        url: 'https://gone.example.com/photo.png',
        asset_id: assetId,
      }),
    }),
    userId,
    {
      ...f.deps,
      readExisting: async () => ({ data: asset, error: null }),
      importURL: () => {
        throw new Error('Must not fetch again')
      },
    },
  )
  assertEquals(response.status, 200)
  assertEquals(await response.json(), { asset })
  assertEquals(f.calls, [])
})
Deno.test('URL rejection never reserves bytes or creates objects', async () => {
  const f = fake()
  const response = await importImageRequest(
    new Request(`https://example.com/images?project_id=${projectId}&import=1`, {
      method: 'POST',
      body: JSON.stringify({
        url: 'https://127.0.0.1/private.png',
        asset_id: assetId,
      }),
    }),
    userId,
    {
      ...f.deps,
      readExisting: async () => ({ data: null, error: null }),
      importURL: async () => {
        throw new Error('Use a public HTTPS image URL')
      },
    },
  )
  assertEquals(response.status, 400)
  assertEquals(f.objects.size, 0)
  assertEquals(f.calls, [])
})

Deno.test('expired reservations return a recoverable expiry response rather than lost access', async () => {
  const f = fake()
  f.deps.reserve = async () => ({ data: null, error: { code: 'PT410', message: 'This image upload expired.' } })
  const result = await storeImage(bytes, 'image/png', identity, f.deps)
  assertEquals(result.status, 410)
  assertEquals(await result.json(), { error: 'This image upload expired.' })
  assertEquals(f.calls, ['validate'])
})
