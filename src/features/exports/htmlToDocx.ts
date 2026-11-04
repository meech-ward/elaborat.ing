import {DOMParser, type Element, type Node} from '@xmldom/xmldom'
import type {IRunOptions, NumberingDefinition, Paragraph, ParagraphChild, Table} from 'docx'
import {inspectImage} from '@/features/images/format'
import {MAX_IMAGE_BYTES} from '@/features/images/types'
import type {PreparedDocumentExport} from './notionExport'

type Docx = typeof import('docx')
type Block = Paragraph | Table
type Style = {-readonly [Key in 'bold' | 'italics' | 'underline' | 'strike' | 'superScript' | 'subScript' | 'font' | 'size' | 'color' | 'shading']?: IRunOptions[Key]}
type Context = {width: number; quote?: number; caption?: boolean; style?: Style; list?: {reference: string; level: number}; task?: boolean; item?: {used: boolean}}
type Raster = {bytes: Uint8Array; type: 'png' | 'jpg'; width: number; height: number}

const PAGE_WIDTH = 9360 // 6.5 inches in twips, within one-inch Letter margins.
const IMAGE_HEIGHT = 784 // Leave room for a heading/caption within nine inches.
const MAX_NODES = 50_000
const BLOCK = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'blockquote', 'ul', 'ol', 'li', 'table', 'figure', 'figcaption', 'hr', 'dl', 'dt', 'dd'])
const CONTAINER = new Set(['html', 'body', 'article', 'section', 'div', 'main', 'header', 'footer', 'aside', 'details'])
const OMIT = new Set(['head', 'script', 'style', 'iframe', 'object', 'embed', 'template', 'noscript', 'svg', 'math', 'canvas', 'textarea', 'select', 'option', 'dialog', 'audio', 'video'])
const children = (node: Node) => Array.from({length: node.childNodes.length}, (_, index) => node.childNodes.item(index)!).filter(Boolean)
const tag = (node: Node) => node.nodeType === 1 ? (node as Element).tagName.toLowerCase() : ''
const attr = (node: Node, name: string) => node.nodeType === 1 ? (node as Element).getAttribute(name) ?? '' : ''
const span = (node: Node, name: string) => Math.max(1, Math.min(32, Math.floor(Number(attr(node, name))) || 1))

/** Only validated local bytes reach the browser decoder. PNG/JPEG originals
 * remain byte exact; formats that Word cannot display become a bounded PNG. */
export async function docxRaster(bytes: Uint8Array, signal?: AbortSignal): Promise<Raster> {
  signal?.throwIfAborted()
  const info = inspectImage(bytes)
  if (!info.animated && info.orientation === 1 && (info.mediaType === 'image/png' || info.mediaType === 'image/jpeg'))
    return {bytes, type: info.mediaType === 'image/png' ? 'png' : 'jpg', width: info.width, height: info.height}
  if (info.mediaType === 'image/svg+xml') throw new Error('The document contains an unrasterized SVG.')
  let bitmap: ImageBitmap | HTMLImageElement | undefined
  let url: string | undefined
  let canvas: HTMLCanvasElement | undefined
  try {
    const blob = new Blob([new Uint8Array(bytes)], {type: info.mediaType})
    if (typeof createImageBitmap === 'function') bitmap = await createImageBitmap(blob, {imageOrientation: 'from-image'})
    else {
      const image = new Image()
      url = URL.createObjectURL(blob)
      image.src = url
      await image.decode()
      bitmap = image
    }
    signal?.throwIfAborted()
    const rotated = info.orientation >= 5 && info.orientation <= 8
    canvas = document.createElement('canvas')
    canvas.width = rotated ? info.height : info.width
    canvas.height = rotated ? info.width : info.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('An image could not be converted for Google Docs.')
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const raster = await new Promise<Blob | null>(resolve => canvas!.toBlob(resolve, 'image/png'))
    signal?.throwIfAborted()
    if (!raster || raster.size > MAX_IMAGE_BYTES) throw new Error('An image exceeds the 5 MiB PNG limit for Google Docs.')
    const output = new Uint8Array(await raster.arrayBuffer())
    const checked = inspectImage(output, 'image/png')
    return {bytes: output, type: 'png', width: checked.width, height: checked.height}
  } finally {
    if (bitmap && 'close' in bitmap) bitmap.close()
    if (url) URL.revokeObjectURL(url)
    if (canvas) {canvas.width = 0; canvas.height = 0}
  }
}

/** A safe semantic document becomes native paragraphs, runs, tables and
 * embedded images. No HTML altChunk, remote asset fetch or active content. */
export async function htmlToDocx(input: Pick<PreparedDocumentExport, 'html' | 'assets' | 'filenameStem'>, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  signal?.throwIfAborted()
  const encoded = new TextEncoder().encode(input.html)
  if (encoded.length > 5 * 1024 * 1024) throw new Error('The converted document exceeds 5 MiB.')
  if (new TextDecoder().decode(encoded) !== input.html || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/.test(input.html))
    throw new Error('This document contains characters that Google Docs cannot represent.')
  let invalid = false
  let parsed: ReturnType<DOMParser['parseFromString']>
  try {
    // Keep parser-specific exception types inside this input boundary. Warnings
    // also invalidate the export rather than accepting a repaired document.
    parsed = new DOMParser({onError: () => {invalid = true}}).parseFromString(input.html, 'text/html')
  } catch {
    throw new Error('The converted document is invalid.')
  }
  if (invalid || !parsed.documentElement || parsed.doctype?.publicId || parsed.doctype?.systemId || parsed.doctype?.internalSubset)
    throw new Error('The converted document is invalid.')
  let nodes = 0
  const validate = (node: Node, depth: number) => {
    if (++nodes > MAX_NODES || depth > 64) throw new Error('This document is too complex to export to Google Docs.')
    for (const child of children(node)) validate(child, depth + 1)
  }
  validate(parsed.documentElement, 0)
  if (input.assets.length > 256 || input.assets.reduce((sum, file) => sum + file.bytes.length, 0) > 64 * 1024 * 1024)
    throw new Error('The document images exceed the export limit.')
  const assets = new Map(input.assets.map(file => [file.path, file.bytes]))
  if (assets.size !== input.assets.length || [...assets.keys()].some(path => !/^assets\/[a-f0-9]{64}\.(?:png|jpg|webp|gif)$/.test(path)))
    throw new Error('The document contains an invalid packaged image.')
  const api = await import('docx')
  signal?.throwIfAborted()
  const headingIds = new Map<Node, string>()
  const anchors = new Map<string, string>()
  const headingSlugs = new Map<string, number>()
  for (const heading of Array.from(parsed.getElementsByTagName('*')).filter(node => /^h[1-6]$/.test(tag(node)))) {
    const stem = (heading.textContent ?? '').toLowerCase().replace(/[^\p{L}\p{N}_\- ]/gu, '').replaceAll(' ', '-')
    const count = headingSlugs.get(stem) ?? 0
    headingSlugs.set(stem, count + 1)
    const id = `elaborating_heading_${headingIds.size + 1}`
    headingIds.set(heading, id)
    anchors.set(count ? `${stem}-${count}` : stem, id)
  }
  const numbering: NumberingDefinition[] = []
  const rasters = new Map<string, Promise<Raster>>()
  let rasterBytes = 0
  const image = async (node: Node, width: number) => {
    const path = attr(node, 'src')
    const bytes = assets.get(path)
    if (!bytes) throw new Error('An image is not included in the document export.')
    let pending = rasters.get(path)
    if (!pending) {
      pending = docxRaster(bytes, signal).then(raster => {
        rasterBytes += raster.bytes.length
        if (rasterBytes > 64 * 1024 * 1024) throw new Error('The converted images exceed 64 MiB.')
        return raster
      })
      rasters.set(path, pending)
    }
    const raster = await pending
    signal?.throwIfAborted()
    const scale = Math.min(1, width / 15 / raster.width, IMAGE_HEIGHT / raster.height)
    return new api.ImageRun({data: raster.bytes, type: raster.type,
      transformation: {width: Math.max(1, Math.round(raster.width * scale)), height: Math.max(1, Math.round(raster.height * scale))},
      altText: {name: attr(node, 'alt') || 'Document image', description: attr(node, 'alt'), title: attr(node, 'title')}})
  }
  const inline = async (node: Node, context: Context, style: Style = context.style ?? {}): Promise<ParagraphChild[]> => {
    signal?.throwIfAborted()
    if (node.nodeType === 3 || node.nodeType === 4) return [new api.TextRun({text: node.nodeValue ?? '', ...style})]
    if (node.nodeType !== 1 || OMIT.has(tag(node)) || attr(node, 'hidden') || attr(node, 'aria-hidden') === 'true') return []
    const name = tag(node)
    if (name === 'input') return attr(node, 'type') === 'checkbox' ? [new api.TextRun({text: (node as Element).hasAttribute('checked') ? '☑ ' : '☐ ', ...style})] : []
    if (name === 'img') return [await image(node, context.width)]
    if (name === 'br') return [new api.TextRun({break: 1})]
    const next: Style = {...style}
    if (name === 'strong' || name === 'b') next.bold = true
    if (name === 'em' || name === 'i') next.italics = true
    if (name === 'u') next.underline = {type: api.UnderlineType.SINGLE}
    if (name === 's' || name === 'del') next.strike = true
    if (name === 'sup') next.superScript = true
    if (name === 'sub') next.subScript = true
    if (name === 'code' || name === 'kbd' || name === 'samp') {next.font = 'Courier New'; next.size = 20}
    if (name === 'mark') next.shading = {fill: 'FFF2CC'}
    const result: ParagraphChild[] = []
    for (const child of children(node)) result.push(...await inline(child, context, next))
    if (name === 'a') {
      const href = attr(node, 'href')
      if (href.startsWith('#')) {
        let anchor: string | undefined
        try {anchor = anchors.get(decodeURIComponent(href.slice(1)))} catch { /* Invalid anchors stay readable text. */ }
        if (anchor) return [new api.InternalHyperlink({anchor, children: result})]
      }
      if (/^(?:https?:\/\/|mailto:|tel:)/i.test(href) && !/[\u0000-\u0020\\]/.test(href))
        return [new api.ExternalHyperlink({link: href, children: result})]
    }
    return result
  }
  const paragraph = (runs: ParagraphChild[], context: Context, properties: ConstructorParameters<Docx['Paragraph']>[0] = {}) => {
    const options = typeof properties === 'string' ? {text: properties} : properties
    const first = !context.item?.used
    if (context.item) context.item.used = true
    return new api.Paragraph({children: runs, spacing: {after: context.caption ? 160 : 120, line: 276},
      ...(context.quote ? {indent: {left: context.quote * 360}, border: {left: {style: api.BorderStyle.SINGLE, size: 8, color: 'B8BDC5', space: 8}}} : {}),
      ...(context.list && !context.task && first ? {numbering: context.list} : context.list ? {indent: {left: context.list.level * 360 + (context.task ? 0 : 360)}} : {}),
      ...(context.caption ? {alignment: api.AlignmentType.CENTER, style: 'Caption'} : {}), ...options})
  }
  const list = async (node: Node, context: Context): Promise<Block[]> => {
    const level = Math.min(8, context.list ? context.list.level + 1 : 0)
    const reference = `document-list-${numbering.length + 1}`
    const ordered = tag(node) === 'ol'
    const start = Math.max(1, Math.min(1_000_000_000, Number(attr(node, 'start')) || 1))
    numbering.push({reference, levels: Array.from({length: 9}, (_, index) => ({level: index,
      format: ordered ? api.LevelFormat.DECIMAL : api.LevelFormat.BULLET,
      text: ordered ? `%${index + 1}.` : ['•', '◦', '▪'][index % 3], start: index === level ? start : 1,
      alignment: api.AlignmentType.LEFT, style: {paragraph: {indent: {left: (index + 1) * 360, hanging: 180}}, run: {font: 'Arial', size: 22}}}))})
    const result: Block[] = []
    for (const item of children(node).filter(child => tag(child) === 'li')) {
      const ownCheckbox = (node: Node): boolean => tag(node) === 'input' && attr(node, 'type') === 'checkbox' ||
        !['ul', 'ol'].includes(tag(node)) && children(node).some(ownCheckbox)
      const task = children(item).some(ownCheckbox)
      const next = {...context, width: Math.max(720, context.width - 360), list: {reference, level}, task, item: {used: false}}
      const content = await blocks(children(item), next)
      result.push(...(content.length ? content : [paragraph([], next)]))
    }
    return result
  }
  const table = async (node: Node, context: Context): Promise<Table> => {
    const rows: Element[] = []
    for (const child of children(node)) {
      if (tag(child) === 'tr') rows.push(child as Element)
      else if (['thead', 'tbody', 'tfoot'].includes(tag(child))) rows.push(...children(child).filter(row => tag(row) === 'tr') as Element[])
    }
    const geometry: Array<Array<{node: Element; columns: number; rows: number; start: number}>> = []
    const occupied: number[] = []
    const incoming: boolean[] = []
    let columns = 1
    for (const [rowIndex, row] of rows.entries()) {
      incoming.push(occupied.some(until => until > rowIndex))
      let cursor = 0
      const cells: typeof geometry[number] = []
      for (const cell of children(row).filter(child => ['th', 'td'].includes(tag(child)))) {
        const width = span(cell, 'colspan'), height = Math.min(span(cell, 'rowspan'), rows.length - rowIndex)
        while (Array.from({length: width}, (_, offset) => occupied[cursor + offset]).some(until => until > rowIndex)) cursor++
        if (cursor + width > 32) throw new Error('A table has more than 32 columns.')
        cells.push({node: cell as Element, columns: width, rows: height, start: cursor})
        for (let offset = 0; offset < width; offset++) occupied[cursor + offset] = rowIndex + height
        cursor += width
      }
      columns = Math.max(columns, occupied.length, cursor)
      geometry.push(cells)
    }
    const widths = Array.from({length: columns}, (_, index) => Math.floor(context.width / columns) + (index === columns - 1 ? context.width % columns : 0))
    const converted = []
    for (const [index, cells] of geometry.entries()) {
      const convertedCells = []
      for (const cell of cells) {
        const width = widths.slice(cell.start, cell.start + cell.columns).reduce((sum, size) => sum + size, 0)
        const content = await blocks(children(cell.node), {width: Math.max(240, width - 160), style: {size: 20, ...(tag(cell.node) === 'th' ? {bold: true} : {})}})
        if (!content.length || content.at(-1) instanceof api.Table) content.push(paragraph([], context))
        convertedCells.push(new api.TableCell({children: content, columnSpan: cell.columns, rowSpan: cell.rows,
          width: {size: width, type: api.WidthType.DXA}, margins: {top: 80, bottom: 80, left: 80, right: 80},
          ...(tag(cell.node) === 'th' ? {shading: {fill: 'F1F3F5'}} : {})}))
      }
      if (!convertedCells.length && !incoming[index]) convertedCells.push(new api.TableCell({children: [paragraph([], context)], columnSpan: columns}))
      converted.push(new api.TableRow({children: convertedCells, tableHeader: cells.length > 0 && cells.every(cell => tag(cell.node) === 'th'), cantSplit: false,
        ...(index === rows.length - 1 ? {keepNext: false} : {})}))
    }
    if (!converted.length) converted.push(new api.TableRow({children: [new api.TableCell({children: [paragraph([], context)]})]}))
    return new api.Table({rows: converted, width: {size: context.width, type: api.WidthType.DXA}, columnWidths: widths,
      layout: api.TableLayoutType.FIXED, alignment: api.AlignmentType.LEFT,
      borders: {top: {style: api.BorderStyle.SINGLE, size: 4, color: 'CFD4DA'}, bottom: {style: api.BorderStyle.SINGLE, size: 4, color: 'CFD4DA'},
        left: {style: api.BorderStyle.SINGLE, size: 4, color: 'CFD4DA'}, right: {style: api.BorderStyle.SINGLE, size: 4, color: 'CFD4DA'},
        insideHorizontal: {style: api.BorderStyle.SINGLE, size: 4, color: 'CFD4DA'}, insideVertical: {style: api.BorderStyle.SINGLE, size: 4, color: 'CFD4DA'}}})
  }
  const blocks = async (items: Node[], context: Context): Promise<Block[]> => {
    const result: Block[] = []
    let pending: ParagraphChild[] = []
    const flush = () => {if (pending.length) {result.push(paragraph(pending, context)); pending = []}}
    for (const node of items) {
      signal?.throwIfAborted()
      const name = tag(node)
      if (node.nodeType === 8 || OMIT.has(name) || attr(node, 'hidden') || attr(node, 'aria-hidden') === 'true') continue
      if (node.nodeType === 3 && !node.nodeValue?.trim() && !pending.length) continue
      const blockWrapper = node.nodeType === 1 && !BLOCK.has(name) && !CONTAINER.has(name) &&
        children(node).some(child => CONTAINER.has(tag(child)) || BLOCK.has(tag(child)))
      if (CONTAINER.has(name) || BLOCK.has(name) || blockWrapper) {
        flush()
        if (CONTAINER.has(name) || blockWrapper || name === 'figure' || name === 'dl') result.push(...await blocks(children(node), context))
        else if (name === 'blockquote') result.push(...await blocks(children(node), {...context, width: Math.max(720, context.width - 360), quote: (context.quote ?? 0) + 1}))
        else if (name === 'ul' || name === 'ol') result.push(...await list(node, context))
        else if (name === 'table') result.push(await table(node, context))
        else if (name === 'pre') {
          const lines = (node.textContent ?? '').split('\n')
          const runs = lines.map((text, index) => new api.TextRun({text, ...(index ? {break: 1} : {}), font: 'Courier New', size: 18, noProof: true}))
          result.push(paragraph(runs, context, {shading: {fill: 'F4F5F7'}, spacing: {before: 80, after: 160, line: 240}, wordWrap: true, keepLines: false}))
        } else if (name === 'hr') result.push(paragraph([], context, {border: {bottom: {style: api.BorderStyle.SINGLE, size: 4, color: 'CFD4DA'}}}))
        else {
          const next = {...context, ...(name === 'figcaption' ? {caption: true} : {})}
          const runs: ParagraphChild[] = []
          for (const child of children(node)) runs.push(...await inline(child, next))
          const depth = /^h([1-6])$/.exec(name)?.[1]
          const heading = depth ? [api.HeadingLevel.HEADING_1, api.HeadingLevel.HEADING_2, api.HeadingLevel.HEADING_3, api.HeadingLevel.HEADING_4, api.HeadingLevel.HEADING_5, api.HeadingLevel.HEADING_6][Number(depth) - 1] : undefined
          const bookmark = headingIds.get(node)
          result.push(paragraph(bookmark ? [new api.Bookmark({id: bookmark, children: runs})] : runs, next,
            heading ? {heading, keepNext: true} : name === 'dt' ? {run: {bold: true}} : {}))
        }
      } else pending.push(...await inline(node, context))
    }
    flush()
    return result
  }
  const body = parsed.getElementsByTagName('body').item(0)
  const content = await blocks(body ? children(body) : [parsed.documentElement], {width: PAGE_WIDTH})
  const heading = (size: number) => ({run: {font: 'Arial', size, bold: true, color: '000000'}, paragraph: {spacing: {before: 240, after: 120}, keepNext: true}})
  const document = new api.Document({creator: 'elaborat.ing', title: input.filenameStem,
    styles: {default: {document: {run: {font: 'Arial', size: 22, color: '000000'}, paragraph: {spacing: {after: 120, line: 276}}},
      title: heading(44), heading1: heading(40), heading2: heading(32), heading3: heading(28), heading4: heading(24), heading5: heading(22), heading6: heading(22),
      caption: {run: {font: 'Arial', size: 20, italics: true, color: '444444'}}}},
    numbering: {config: numbering}, sections: [{properties: {page: {size: {width: 12240, height: 15840}, margin: {top: 1440, right: 1440, bottom: 1440, left: 1440}}},
      children: content.length ? content : [new api.Paragraph('')]}]})
  signal?.throwIfAborted()
  const output = await api.Packer.toArrayBuffer(document)
  signal?.throwIfAborted()
  if (output.byteLength > 70 * 1024 * 1024) throw new Error('The Google Docs document exceeds 70 MiB.')
  return new Uint8Array(output)
}
