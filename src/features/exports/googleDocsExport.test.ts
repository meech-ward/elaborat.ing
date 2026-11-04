import {describe, expect, test} from 'bun:test'
import {DOMParser} from '@xmldom/xmldom'
import {unzipSync, strFromU8, zlibSync} from 'fflate'
import {buildGoogleDocsExport, GOOGLE_DOCS_MIME} from './googleDocsExport'
import {docxRaster, htmlToDocx} from './htmlToDocx'
import {buildNotionExport, prepareDocumentExport, type NotionWorkspace} from './notionExport'
import type {WorkspaceFile} from '@/features/workbench/workspaceStore'

const file = (path: string, content = ''): WorkspaceFile => ({path, content, savedContent: content,
  revision: 'saved-1', size: content.length, draft: false, unsynced: false, conflict: false, server: null})
const client: NotionWorkspace = {read: async path => {throw new Error(`Unexpected file: ${path}`)}}
const parse = (xml: string) => new DOMParser().parseFromString(xml, 'application/xml')
const allText = (xml: string) => Array.from(parse(xml).getElementsByTagName('w:t')).map(node => node.textContent ?? '').join('')
const xmlPart = (zip: Record<string, Uint8Array>, path = 'word/document.xml') => strFromU8(zip[path])

function png(width: number, height: number) {
  const crc = (bytes: Uint8Array) => {
    let value = 0xffffffff
    for (const byte of bytes) {value ^= byte; for (let bit = 0; bit < 8; bit++) value = value >>> 1 ^ (value & 1 ? 0xedb88320 : 0)}
    return (value ^ 0xffffffff) >>> 0
  }
  const chunk = (name: string, bytes: Uint8Array) => {
    const result = new Uint8Array(bytes.length + 12)
    const view = new DataView(result.buffer)
    view.setUint32(0, bytes.length)
    result.set(new TextEncoder().encode(name), 4); result.set(bytes, 8)
    view.setUint32(bytes.length + 8, crc(result.subarray(4, bytes.length + 8)))
    return result
  }
  const header = new Uint8Array(13)
  new DataView(header.buffer).setUint32(0, width); new DataView(header.buffer).setUint32(4, height)
  header.set([8, 2], 8)
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', zlibSync(new Uint8Array((width * 3 + 1) * height))), chunk('IEND', new Uint8Array())]
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0; for (const part of parts) {result.set(part, offset); offset += part.length}
  return result
}

describe('browser generated Google Docs document', () => {
  test('semantic text becomes editable OOXML with headings, formatting, lists, tasks, code and fixed-width tables', async () => {
    const source = '# Editable document\n\n## Details\n\n日本語 – naïve 🧪 **Bold** *italic* ~~removed~~ and [a link](https://example.com/help?a=1&b=2).\n\n3. First\n4. Second\n   - Nested\n\n- [x] Completed\n- [ ] Remaining\n\n> Quoted paragraph\n\n```cpp\nint main() {\n  return 0;\n}\n```\n\n| Name | Value |\n| --- | --- |\n| Alpha | Editable |'
    const output = await buildGoogleDocsExport({path: 'notes/export.mdx', source, client})
    expect(output.filename).toBe('export-google-docs.docx')
    expect(output.mimeType).toBe(GOOGLE_DOCS_MIME)
    expect(output.documentCount).toBe(1)
    expect(output.assetCount).toBe(0)
    expect(output.diagnostics).toEqual([])
    const zip = unzipSync(output.bytes)
    const xml = xmlPart(zip), text = allText(xml)
    expect(Object.keys(zip)).toContain('[Content_Types].xml')
    expect(xml).toContain('w:pStyle w:val="Heading1"')
    expect(xml).toContain('w:pStyle w:val="Heading2"')
    for (const value of ['Editable document', '日本語 – naïve 🧪', 'Bold', 'italic', 'removed', '☑ ', '☐ ', 'Quoted paragraph', 'int main() {', '  return 0;', 'Alpha', 'Editable'])
      expect(text).toContain(value)
    expect(xml).toContain('<w:b/>')
    expect(xml).toContain('<w:i/>')
    expect(xml).toContain('<w:strike/>')
    expect(xml).toContain('<w:br/>')
    expect(xml).toContain('w:tblHeader')
    expect(xml).toContain('w:tblLayout w:type="fixed"')
    expect(xml).toContain('w:gridCol w:w="4680"')
    expect(xml).not.toMatch(/altChunk|<w:fldChar|INCLUDEPICTURE/)
    expect(xmlPart(zip, 'word/numbering.xml')).toContain('w:start w:val="3"')
    expect(xmlPart(zip, 'word/_rels/document.xml.rels')).toContain('https://example.com/help?a=1&amp;b=2')
    const styles = xmlPart(zip, 'word/styles.xml')
    expect(styles).toContain('w:color w:val="000000"')
    expect(styles).toContain('w:ascii="Arial"')
    expect(styles).not.toContain('w:pBdr')
  })

  test('original images are embedded byte exactly, deduplicated, captioned and fit both page dimensions', async () => {
    const wide = png(6000, 300), tall = png(300, 6000)
    const pictures = new Map([['images/wide.png', wide], ['images/tall.png', tall]])
    const workspace: NotionWorkspace = {read: async path => {
      if (path === 'child.md') return file(path, '# Included child')
      if (pictures.has(path)) return {...file(path), kind: 'image'}
      throw new Error('A private file is unavailable')
    }, readImage: async path => new Blob([pictures.get(path)!], {type: 'image/png'}),
    readImageRevision: async (path, revision) => {
      expect(revision).toBe('saved-1'); return new Blob([pictures.get(path)!], {type: 'image/png'})
    }}
    const source = '# Picture export\n\n![Wide image](images/wide.png)\n\n<figure>\n\n![Tall image](images/tall.png)\n\n<figcaption>\n\nA **rich** caption.\n\n</figcaption>\n</figure>\n\n![Again](images/wide.png)\n\n<Document src="child.md" title="Child section" defaultCollapsed />'
    const output = await buildGoogleDocsExport({path: 'pictures.mdx', source, client: workspace})
    const zip = unzipSync(output.bytes)
    const images = Object.entries(zip).filter(([path]) => path.startsWith('word/media/'))
    expect(images).toHaveLength(2)
    expect(images.some(([, bytes]) => bytes.every((byte, index) => byte === wide[index]) && bytes.length === wide.length)).toBe(true)
    expect(images.some(([, bytes]) => bytes.every((byte, index) => byte === tall[index]) && bytes.length === tall.length)).toBe(true)
    expect(output.documentCount).toBe(2)
    expect(output.assetCount).toBe(2)
    expect(output.diagnostics).toEqual([])
    const xml = xmlPart(zip), document = parse(xml)
    expect(allText(xml)).toContain('A rich caption.')
    expect(allText(xml)).toContain('Included child')
    expect(xml).toContain('descr="Tall image"')
    const extents = Array.from(document.getElementsByTagName('wp:extent'))
    expect(extents).toHaveLength(3)
    for (const extent of extents) {
      expect(Number(extent.getAttribute('cx'))).toBeLessThanOrEqual(6.5 * 914400)
      expect(Number(extent.getAttribute('cy'))).toBeLessThanOrEqual(9 * 914400)
    }
    expect(Number(extents[0].getAttribute('cx')) / Number(extents[0].getAttribute('cy'))).toBeCloseTo(20, 0)
    expect(Number(extents[1].getAttribute('cy')) / Number(extents[1].getAttribute('cx'))).toBeCloseTo(20, 0)
  })

  test('common preparation and Notion ZIP keep the same HTML, local assets and diagnostics', async () => {
    const source = '# Same source\n\nA paragraph.\n\n<Document src="missing.md" />'
    const options = {path: 'same.mdx', source, client}
    const prepared = await prepareDocumentExport(options)
    const notion = await buildNotionExport(options)
    const google = await buildGoogleDocsExport(options)
    const zip = unzipSync(notion.bytes)
    expect(strFromU8(zip['same.html'])).toBe(prepared.html)
    expect(notion.filename).toBe('same-notion.zip')
    expect(prepared.filenameStem).toBe('same')
    expect(google.documentCount).toBe(notion.documentCount)
    expect(google.assetCount).toBe(notion.assetCount)
    expect(google.diagnostics).toEqual(notion.diagnostics)
    expect(prepared.diagnostics).toEqual(notion.diagnostics)
    expect(allText(xmlPart(unzipSync(google.bytes)))).toContain('unavailable')
  })

  test('active markup and form values cannot enter OOXML and remote images are never fetched', async () => {
    const bytes = await htmlToDocx({filenameStem: 'safe', assets: [], html: '<html><body><span><div><h2>Nested component result</h2><p>Readable result.</p></div></span><script>privateScript()</script><form><label>Email<input value="private@example.invalid" /></label><input type="password" value="password-secret" /><textarea>private draft</textarea><button>Continue</button></form></body></html>'})
    const xml = xmlPart(unzipSync(bytes)), text = allText(xml)
    expect(text).toContain('Nested component result')
    expect(text).toContain('Readable result.')
    expect(text).toContain('Continue')
    expect(text).not.toMatch(/privateScript|private@example|password-secret|private draft/)
    expect(xml).toContain('w:pStyle w:val="Heading2"')
    await expect(htmlToDocx({filenameStem: 'remote', assets: [], html: '<img src="https://outside.example/private.png" />'})).rejects.toThrow('not included')
    await expect(htmlToDocx({filenameStem: 'external', assets: [], html: '<!DOCTYPE html SYSTEM "https://outside.example/entity"><html><body>Text</body></html>'})).rejects.toThrow('invalid')
  })

  test('source, complexity, image and cancellation limits apply before packaging', async () => {
    const controller = new AbortController(); controller.abort()
    await expect(buildGoogleDocsExport({path: 'canceled.md', source: '# Canceled', client, signal: controller.signal})).rejects.toHaveProperty('name', 'AbortError')
    await expect(htmlToDocx({filenameStem: 'large', assets: [], html: 'x'.repeat(5 * 1024 * 1024 + 1)})).rejects.toThrow('5 MiB')
    await expect(htmlToDocx({filenameStem: 'deep', assets: [], html: '<div>'.repeat(66) + 'Deep' + '</div>'.repeat(66)})).rejects.toThrow('complex')
    await expect(htmlToDocx({filenameStem: 'many', assets: [], html: '<div>' + '<span></span>'.repeat(50_001) + '</div>'})).rejects.toThrow('complex')
    await expect(docxRaster(png(9000, 1000))).rejects.toThrow('8 million')
    const image = png(10, 20)
    expect(await docxRaster(image)).toMatchObject({bytes: image, type: 'png', width: 10, height: 20})
    await expect(htmlToDocx({filenameStem: 'bad', html: '<p>Safe</p>', assets: [{path: '../private.png', bytes: image}]})).rejects.toThrow('invalid packaged image')
    await expect(htmlToDocx({filenameStem: 'invalid', html: '<p>Invalid\u0000text</p>', assets: []})).rejects.toThrow('characters')
  })

  test('heading links become local bookmarks and loose list paragraphs do not acquire extra numbering', async () => {
    const source = '# Export\n\n[Jump to details](#details)\n\n## Details\n\n3. First paragraph.\n\n   Second paragraph in the same item.\n\n4. Next item.\n\n   - Nested item.'
    const output = await buildGoogleDocsExport({path: 'links.md', source, client})
    const xml = xmlPart(unzipSync(output.bytes)), doc = parse(xml)
    expect(xml).toContain('w:bookmarkStart')
    expect(xml).toContain('w:anchor="elaborating_heading_2"')
    const paragraphs = Array.from(doc.getElementsByTagName('w:p'))
    const numbered = paragraphs.filter(node => node.getElementsByTagName('w:numPr').length > 0)
    expect(numbered).toHaveLength(3)
    expect(numbered.map(node => node.textContent ?? '').join(' ')).not.toContain('Second paragraph in the same item.')
  })
})
