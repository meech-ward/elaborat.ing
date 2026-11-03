import {expect, test} from 'bun:test'
import {unzipSync, strFromU8} from 'fflate'
import {buildNotionExport, frozenNotionWorkspace, notionExportName, type NotionWorkspace} from './notionExport'
import type {WorkspaceFile} from '../workbench/workspaceStore'
import {imageObjectKeys} from '../images/types'

const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='), char => char.charCodeAt(0))
const file = (path: string, content = ''): WorkspaceFile => ({path, content, savedContent: content,
  revision: '1', size: content.length, draft: false, unsynced: false, conflict: false, server: null})

test('Notion ZIP includes current root and child drafts plus byte-exact deduplicated image copies, with no export metadata pages', async () => {
  const reads: string[] = []
  const client: NotionWorkspace = {read: async path => {
    reads.push(path)
    if (path === 'details.md') return file(path, 'Old saved text')
    if (path === 'images/a.png') return {...file(path), kind: 'image'}
    throw new Error(`Unexpected export read: ${path}`)
  }, readImage: async () => new Blob([png], {type: 'image/png'})}
  // The frozen adapter verifies the asset identity before reading by path.
  const asset = {id: 'e16f0557-18dc-4a4b-87e7-2230ac4fb124', ...imageObjectKeys('e81a09f3-5594-4f97-aae5-bcd3d09592fa', 'e16f0557-18dc-4a4b-87e7-2230ac4fb124'),
    media_type: 'image/png' as const, width: 1, height: 1, byte_length: png.length, sha256: 'a'.repeat(64), preview_type: 'image/png' as const, preview_byte_length: png.length}
  const read = client.read
  client.read = async path => {const result = await read(path); return path === 'images/a.png' ? {...result, asset} : result}
  const source = '# Current title\n\n![First](images/a.png)\n\n<Document src="details.md" title="Details" defaultCollapsed />\n\n![Again](images/a.png)'
  const output = await buildNotionExport({path: 'launch.mdx', source, client,
    sources: new Map([['details.md', 'The current child draft.\n\n![Child](images/a.png)']])})
  const zip = unzipSync(output.bytes)
  expect(Object.keys(zip).filter(path => path.endsWith('.html'))).toEqual(['launch.html'])
  expect(Object.keys(zip)).toHaveLength(2)
  const imagePath = Object.keys(zip).find(path => path.startsWith('assets/'))!
  expect(zip[imagePath]).toEqual(png)
  const html = strFromU8(zip['launch.html'])
  expect(html).toContain('<h1>Current title</h1>')
  expect(html).toContain('The current child draft.')
  expect(html).not.toContain('Old saved text')
  expect(html.match(new RegExp(imagePath.replaceAll('.', '\\.'), 'g'))).toHaveLength(3)
  expect(html).not.toContain('data:')
  expect(reads).not.toContain('launch.mdx')
  expect(output).toMatchObject({filename: 'launch-notion.zip', documentCount: 2, assetCount: 1, diagnostics: []})
})

test('circular, missing and computed embeds preserve readable diagnostics without traversing unrelated files', async () => {
  const reads: string[] = []
  const client = {read: async (path: string) => {reads.push(path); if (path === 'root.mdx') return file(path, '<Document src="root.mdx" />'); throw new Error('Missing')}}
  const output = await buildNotionExport({path: 'root.mdx', source: '# Export\n\n<Document src="root.mdx" />\n\n<Document src="missing.md" />\n\n<Document src={secret} />', client})
  expect(output.diagnostics).toHaveLength(3)
  expect(reads).toEqual(['root.mdx', 'missing.md'])
  const html = strFromU8(unzipSync(output.bytes)['root.html'])
  expect(html).toContain('root.mdx')
  expect(html).toContain('missing.md')
  expect(html).toContain('src={secret}')
})

test('snapshot DOM is sanitized, packaged locally and asked for only once per document', async () => {
  const source = '<CustomOne />\n\n<CustomTwo />'
  let captures = 0
  const output = await buildNotionExport({path: 'note.mdx', source, client: {read: async path => file(path)},
    snapshot: async () => {captures++; return [
      {from: 0, to: 13, html: '<h2>Rendered component</h2><script>secret()</script>'},
      {from: 15, to: 28, html: '<p>Second component</p>'},
    ]}})
  expect(captures).toBe(1)
  const html = strFromU8(unzipSync(output.bytes)['note.html'])
  expect(html).toContain('Rendered component')
  expect(html).toContain('Second component')
  expect(html).not.toContain('<script>')
  expect(html).not.toContain('secret()')
})

test('frozen assets read immutable IDs and refuse a replacement race when no immutable reader exists', async () => {
  const first = {...file('a.png'), kind: 'image' as const, asset: {id: 'old'}} as WorkspaceFile
  const second = {...first, asset: {id: 'new'}} as WorkspaceFile
  let current = first
  const client = {read: async () => current, readImage: async () => {current = second; return new Blob([png])}}
  const frozen = frozenNotionWorkspace(client, new Map())
  await frozen.read('a.png')
  await expect(frozen.readImage!('a.png')).rejects.toThrow('changed during export')
  const ids: string[] = []
  const immutable = frozenNotionWorkspace({...client, readImageAsset: async id => {ids.push(id); return new Blob([png])}}, new Map())
  await immutable.readImage!('a.png')
  expect(ids).toEqual(['new'])
})

test('unsafe names, oversized sources and cancellation are bounded before doing export work', async () => {
  expect(notionExportName('folder/.odd:name.mdx')).toBe('odd-name')
  const client = {read: async (path: string) => file(path)}
  await expect(buildNotionExport({path: '../secret.mdx', source: '', client})).rejects.toThrow('Choose')
  await expect(buildNotionExport({path: 'note.md', source: 'x'.repeat(2 * 1024 * 1024 + 1), client})).rejects.toThrow('source limit')
  const controller = new AbortController(); controller.abort()
  await expect(buildNotionExport({path: 'note.md', source: '', client, signal: controller.signal})).rejects.toHaveProperty('name', 'AbortError')
  await expect(frozenNotionWorkspace(client, new Map()).read('../secret.mdx')).rejects.toThrow('not a project file')
})
