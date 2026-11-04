import {describe, expect, test} from 'bun:test'
import {strFromU8, unzipSync} from 'fflate'
import {buildNotionExport, frozenNotionWorkspace} from '@/features/exports/notionExport'
import {sharedNotionWorkspace} from './sharedNotionWorkspace'
import type {SharedBundle} from './publicRemote'

const ORIGINAL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='
const PREVIEW = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY6kAAAAASUVORK5CYII='
const SHARE = 'a0000000-0000-4000-8000-000000000001'
const ROOT = 'b0000000-0000-4000-8000-000000000001'
const IMAGE = 'c0000000-0000-4000-8000-000000000001'
const bytes = (dataURL: string) => Uint8Array.from(atob(dataURL.split(',')[1]), value => value.charCodeAt(0))

function bundle(): SharedBundle {
  return {share: {id: SHARE, file_id: ROOT, path: 'notes/root.mdx', version: 2, revision: 9, archived: false}, files: [
    {id: ROOT, path: 'notes/root.mdx', content: '# Shared root\n\n![Original](../images/photo.png)', version: 2},
    {id: IMAGE, path: 'images/photo.png', content: '', version: 8},
  ], images: [{path: 'images/photo.png', dataURL: ORIGINAL, width: 1, height: 1,
    preview: {dataURL: PREVIEW, width: 1, height: 1}}]}
}

describe('finite shared Notion workspace', () => {
  test('exposes read-only saved files and original bytes without Storage metadata or account operations', async () => {
    const client = sharedNotionWorkspace(bundle())
    expect(Object.keys(client).sort()).toEqual(['read', 'readImage', 'readImageRevision'])
    const note = await client.read('notes/root.mdx')
    expect(note).toMatchObject({path: 'notes/root.mdx', kind: 'text', content: '# Shared root\n\n![Original](../images/photo.png)',
      draft: false, unsynced: false, conflict: false, server: {id: ROOT, version: 2}})
    expect(note.savedContent).toBe(note.content)
    const image = await client.read('images/photo.png')
    expect(image).toMatchObject({kind: 'image', server: {id: IMAGE, version: 8}, size: bytes(ORIGINAL).length})
    expect(image.asset).toBeUndefined()
    const original = await client.readImage!('images/photo.png')
    const preview = await client.readImage!('images/photo.png', true)
    expect(original.type).toBe('image/png')
    expect(new Uint8Array(await original.arrayBuffer())).toEqual(bytes(ORIGINAL))
    expect(new Uint8Array(await preview.arrayBuffer())).toEqual(bytes(PREVIEW))
    expect(new Uint8Array(await original.arrayBuffer())).not.toEqual(new Uint8Array(await preview.arrayBuffer()))
    expect(Object.isFrozen(note)).toBe(true)
    expect(Object.isFrozen(note.server)).toBe(true)
  })

  test('freezes source, file identity and image strings across input mutation and a later shared revision', async () => {
    const input = bundle()
    const client = sharedNotionWorkspace(input)
    const firstImage = await client.read('images/photo.png')
    input.files[0].content = 'Changed after preparing'
    input.files[1].version++
    input.images[0].dataURL = PREVIEW
    input.images[0].preview.dataURL = ORIGINAL
    input.share.revision++
    expect((await client.read('notes/root.mdx')).content).toStartWith('# Shared root')
    expect((await client.read('images/photo.png')).revision).toBe(firstImage.revision)
    expect(new Uint8Array(await (await client.readImage!('images/photo.png')).arrayBuffer())).toEqual(bytes(ORIGINAL))
    expect(new Uint8Array(await (await client.readImage!('images/photo.png', true)).arrayBuffer())).toEqual(bytes(PREVIEW))
    const next = sharedNotionWorkspace(input)
    await expect(next.readImageRevision!('images/photo.png', firstImage.revision)).rejects.toThrow('revision')
    await expect(client.readImageRevision!('images/photo.png', null)).rejects.toThrow('revision')
    await expect(client.readImageRevision!('notes/root.mdx', firstImage.revision)).rejects.toThrow('revision')
  })

  test('rejects outside, absent and text paths without reading another project or network resource', async () => {
    const client = sharedNotionWorkspace(bundle())
    for (const path of ['../secret.md', 'private/secret.md', 'https://example.com/image.png', '__proto__']) {
      await expect(client.read(path)).rejects.toThrow('not included')
      await expect(client.readImage!(path)).rejects.toThrow('not included')
    }
    await expect(client.readImage!('notes/root.mdx')).rejects.toThrow('not included')
    const withoutPixels = bundle(); withoutPixels.images = []
    const unavailable = sharedNotionWorkspace(withoutPixels)
    await expect(unavailable.read('images/photo.png')).rejects.toThrow('unavailable')
    await expect(unavailable.readImage!('images/photo.png')).rejects.toThrow('unavailable')
  })

  test('rejects image entries without an authorized file, with a text path or with text file contents', () => {
    const absent = bundle(); absent.files.pop()
    expect(() => sharedNotionWorkspace(absent)).toThrow('authorized image file')
    const wrongKind = bundle(); wrongKind.images[0].path = 'notes/root.mdx'
    expect(() => sharedNotionWorkspace(wrongKind)).toThrow('authorized image file')
    const text = bundle(); text.files[1].content = 'Not an image record'
    expect(() => sharedNotionWorkspace(text)).toThrow('authorized image file')
    const duplicate = bundle(); duplicate.files.push({...duplicate.files[0]})
    expect(() => sharedNotionWorkspace(duplicate)).toThrow()
  })

  test('validates original and preview byte signatures, declared dimensions and preview format limits', async () => {
    const corrupted = bundle(); corrupted.images[0].dataURL = 'data:image/png;base64,AAAA'
    await expect(sharedNotionWorkspace(corrupted).readImage!('images/photo.png')).rejects.toThrow()
    const mislabeled = bundle(); mislabeled.images[0].dataURL = ORIGINAL.replace('image/png', 'image/jpeg')
    await expect(sharedNotionWorkspace(mislabeled).readImage!('images/photo.png')).rejects.toThrow()
    const dimensions = bundle(); dimensions.images[0].width = 2
    await expect(sharedNotionWorkspace(dimensions).readImage!('images/photo.png')).rejects.toThrow('dimensions')
    const invalidPreview = bundle(); invalidPreview.images[0].preview.dataURL = PREVIEW.replace('image/png', 'image/gif')
    await expect(sharedNotionWorkspace(invalidPreview).readImage!('images/photo.png', true)).rejects.toThrow()
    const oversized = bundle(); oversized.images[0].width = 8_000_001
    expect(() => sharedNotionWorkspace(oversized)).toThrow()
  })

  test('ordinary export packages full original bytes using the bound public revision and does not include private links', async () => {
    const input = bundle()
    input.files[0].content += '\n\n[Private plan](../private/secret.md)\n\n<Document src="child.md" title="Child" defaultCollapsed />'
    input.files.push({id: 'd0000000-0000-4000-8000-000000000001', path: 'child.md', content: '# Shared child', version: 1})
    const client = sharedNotionWorkspace(input)
    const frozen = frozenNotionWorkspace(client, new Map())
    expect(new Uint8Array(await (await frozen.readImage!('images/photo.png')).arrayBuffer())).toEqual(bytes(ORIGINAL))
    const output = await buildNotionExport({path: input.share.path, source: input.files[0].content, client})
    const zip = unzipSync(output.bytes)
    const imagePath = Object.keys(zip).find(path => path.startsWith('assets/'))!
    expect(zip[imagePath]).toEqual(bytes(ORIGINAL))
    expect(output.documentCount).toBe(2)
    expect(output.assetCount).toBe(1)
    expect(output.diagnostics).toMatchObject([{kind: 'unsafe-url'}])
    const html = strFromU8(zip['root.html'])
    expect(html).toContain('Shared child')
    expect(html).not.toMatch(/https?:\/\/[^<]*projects\/|object_key|preview_key|data:image/)
  })
})
