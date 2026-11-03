import {createProcessor} from '@mdx-js/mdx'
import {DOMImplementation, DOMParser, XMLSerializer, type Element as XmlElement, type Node as XmlNode} from '@xmldom/xmldom'
import remarkGfm from 'remark-gfm'
import remarkFrontmatter from 'remark-frontmatter'
import {normalizeImageFigures} from '../images/figureNodes'
import {decodeImageDataURL} from '../images/transport'
import {inspectImage} from '../images/format'
import {MAX_IMAGE_BYTES} from '../images/types'
import {isDocumentPath} from '../document/documentPaths'

export type NotionHtmlDiagnostic = {
  kind: 'unsupported' | 'missing-asset' | 'unsafe-url' | 'parse'
  message: string
  sourcePath: string
  from: number
  to: number
}
export type NotionHtmlResult = {html: string; diagnostics: NotionHtmlDiagnostic[]}
export type NotionSourceRange = {sourcePath: string; from: number; to: number}
export type NotionAssetReference = NotionSourceRange & {
  kind: 'image' | 'drawing' | 'diagram'
  src: string
  alt: string
  title?: string
}
export type NotionImage = {src: string; alt?: string}
export type NotionDocumentReference = NotionSourceRange & {src: string; title?: string}
export type NotionSnapshotReference = NotionSourceRange & {source: string}
export type NotionSnapshot = NotionImage | {html: string}
export type NotionHtmlOptions = {
  source: string
  path: string
  format: 'md' | 'mdx'
  resolveAsset?: (reference: NotionAssetReference) => Promise<NotionImage | null>
  resolveDocument?: (reference: NotionDocumentReference) => Promise<NotionHtmlResult | null>
  snapshot?: (reference: NotionSnapshotReference) => Promise<NotionSnapshot | null>
  raster?: (dataURL: string) => Promise<string>
  vector?: (svg: string) => Promise<string>
  rewriteLink?: (href: string, sourcePath: string) => string | null
  signal?: AbortSignal
}
export type SanitizeNotionHtmlOptions = {
  path?: string
  from?: number
  to?: number
  rewriteLink?: NotionHtmlOptions['rewriteLink']
  raster?: NotionHtmlOptions['raster']
  vector?: NotionHtmlOptions['vector']
  signal?: AbortSignal
}

type Attribute = {type: string; name?: string; value?: unknown}
type Node = {
  type: string; name?: string; value?: string; url?: string; title?: string; alt?: string
  identifier?: string; lang?: string; depth?: number; ordered?: boolean; start?: number
  checked?: boolean | null; children?: Node[]; attributes?: Attribute[]
  position?: {start: {offset?: number}; end: {offset?: number}}
}
type HtmlNode = {
  nodeType: number; nodeName: string; nodeValue: string | null
  childNodes: {length: number; item(index: number): HtmlNode | null}
  getAttribute?: (name: string) => string | null
  hasAttribute?: (name: string) => boolean
}
const escape = (value: string) => value.replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]!))
const processor = (format: 'md' | 'mdx') => createProcessor({format, remarkPlugins: [remarkGfm, [remarkFrontmatter, ['yaml', 'toml']]]})
const imageTag = (image: NotionImage, alt: string) => `<img src="${escape(image.src)}" alt="${escape(image.alt ?? alt)}" />`

/** Package paths and ordinary document links; never browser executable schemes. */
function safeLink(value: string): boolean {
  if (!value || /[\s\\\u0000-\u001f\u007f-\u009f]/u.test(value) || value.startsWith('//')) return false
  let decoded: string
  try {decoded = decodeURIComponent(value)} catch {return false}
  if (/[\\\u0000-\u001f\u007f-\u009f]/u.test(decoded) || decoded.startsWith('//')) return false
  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(value)?.[1]?.toLowerCase()
  const decodedScheme = /^([a-z][a-z\d+.-]*):/i.exec(decoded)?.[1]?.toLowerCase()
  if (decodedScheme && decodedScheme !== scheme) return false
  if (scheme && !['https', 'http', 'mailto', 'tel'].includes(scheme)) return false
  if (scheme === 'https' || scheme === 'http') {
    try {const url = new URL(value); return Boolean(url.hostname) && !url.username && !url.password} catch {return false}
  }
  return true
}

function rasterDataImage(value: string): boolean {
  try {
    const {bytes, mediaType} = decodeImageDataURL(value)
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(mediaType)) return false
    return !inspectImage(bytes, mediaType).animated
  } catch {return false}
}

/** xmldom's HTML parser does not infer SVG foreign-content namespaces. Build
 * an inert namespace-correct copy instead of editing serialized XML strings. */
function vectorMarkup(element: XmlElement): string {
  const svg = 'http://www.w3.org/2000/svg'
  const document = new DOMImplementation().createDocument(null, '', null)
  let count = 0
  const clone = (source: XmlNode, depth: number): XmlNode => {
    if (++count > 10_000 || depth > 64) throw new Error('The component graphic is too complex.')
    if (source.nodeType !== 1) return document.createTextNode(source.nodeValue ?? '')
    const original = source as XmlElement
    const copy = document.createElementNS(!source.namespaceURI || source.namespaceURI === 'http://www.w3.org/1999/xhtml' ? svg : source.namespaceURI, source.nodeName)
    for (let index = 0; index < original.attributes.length; index++) {
      const attr = original.attributes.item(index)!
      copy.setAttributeNS(attr.namespaceURI, attr.name, attr.value)
    }
    for (let index = 0; index < source.childNodes.length; index++) {
      const child = source.childNodes.item(index)!
      if (child.nodeType === 1 || child.nodeType === 3 || child.nodeType === 4) copy.appendChild(clone(child, depth + 1))
    }
    return copy
  }
  const root = clone(element, 0) as XmlElement
  if (!root.hasAttribute('xmlns')) root.setAttribute('xmlns', svg)
  return new XMLSerializer().serializeToString(root, {requireWellFormed: true})
}

/** Resolver-owned package assets are separate from untrusted snapshot markup. */
function safeImage(value: string): boolean {
  if (value.startsWith('data:')) return rasterDataImage(value)
  if (!safeLink(value) || value.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(value)) return false
  let decoded: string
  try {decoded = decodeURIComponent(value)} catch {return false}
  return !decoded.split('/').some(part => part === '..' || part === '.') && !/[?#]/.test(decoded)
}

function abort(signal?: AbortSignal, error?: unknown): void {
  signal?.throwIfAborted()
  if (error instanceof Error && error.name === 'AbortError') throw error
}

const semanticTags = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'u', 's', 'del', 'a', 'ul', 'ol', 'li', 'pre', 'code', 'blockquote', 'hr', 'br', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'figure', 'figcaption', 'dl', 'dt', 'dd', 'sup', 'sub', 'kbd', 'samp', 'mark'])
const containers = new Set(['div', 'span', 'section', 'article', 'main', 'header', 'footer', 'aside', 'details', 'label', 'button'])
const blocked = new Set(['script', 'style', 'noscript', 'template', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'svg', 'math', 'canvas', 'audio', 'video', 'source', 'dialog'])
const controls = new Set(['input', 'textarea', 'select', 'option', 'optgroup', 'datalist'])
const blockBuiltins = new Set(['Card', 'CardHeader', 'CardContent', 'CardFooter', 'CardDescription', 'Columns', 'Alert', 'AlertDescription', 'SideBySide', 'SideBySide.Block', 'Instruction', 'Instruction.Implementation', 'Tabs'])
const flowTags = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'section', 'article', 'main', 'header', 'footer', 'aside', 'details', 'summary', 'blockquote', 'ul', 'ol', 'li', 'pre', 'table', 'figure', 'figcaption', 'dl', 'dt', 'dd', 'form', 'Document', 'Drawing', 'Diagram', 'Note', 'Warning', 'Important', 'Callout', 'ExampleCard', 'Tab', 'CardTitle', 'AlertTitle', 'Instruction.Action', ...blockBuiltins])
const knownBuiltins = new Set(['Note', 'Warning', 'Important', 'Callout', 'ExampleCard', 'Tab', 'CardTitle', 'AlertTitle', 'Instruction.Action', 'Badge', 'Button', ...blockBuiltins])
const projectPath = (path: string) => path.length > 0 && path.length <= 512 && path.normalize('NFC') === path &&
  new TextEncoder().encode(path).length <= 1024 && !/[\\:\u0000-\u001f\u007f-\u009f]/.test(path) && path.split('/').every(part => part && !part.startsWith('.'))

/** CommonMark splits inline HTML tags from the Markdown between them. Keep
 * those Markdown children instead of reparsing them as literal HTML text. */
function normalizeHtmlPairs(node: Node): void {
  const children = node.children ?? []
  for (let index = 0; index < children.length; index++) {
    const opening = children[index]
    const match = opening.type === 'html' ? /^<([a-z][a-z\d]*)(?:\s[^<>]*)?>$/i.exec(opening.value?.trim() ?? '') : null
    if (match && !['img', 'input', 'br', 'hr', 'meta', 'link', 'source', 'embed'].includes(match[1].toLowerCase())) {
      let depth = 1
      let end = index + 1
      for (; end < children.length; end++) {
        const child = children[end]
        if (child.type !== 'html') continue
        const value = child.value?.trim() ?? ''
        if (new RegExp(`^<${match[1]}(?:\\s[^<>]*)?>$`, 'i').test(value)) depth++
        if (new RegExp(`^</${match[1]}\\s*>$`, 'i').test(value) && --depth === 0) break
      }
      if (depth === 0) {
        try {
          const tree = processor('mdx').parse(`${opening.value}placeholder</${match[1]}>`) as Node
          const element = tree.children?.[0]?.type === 'paragraph' ? tree.children[0].children?.[0] : tree.children?.[0]
          if (element?.type === 'mdxJsxFlowElement' || element?.type === 'mdxJsxTextElement') {
            const paired: Node = {...element, children: children.slice(index + 1, end), position: {start: opening.position!.start, end: children[end].position!.end}}
            children.splice(index, end - index + 1, paired)
          }
        } catch { /* Unsupported HTML still goes through the inert HTML sanitizer. */ }
      }
    }
    normalizeHtmlPairs(children[index])
  }
}

function literal(node: Node, name: string): string | number | boolean | null | undefined {
  const values = node.attributes?.filter(attr => attr.name === name) ?? []
  if (values.length !== 1 || values[0].type !== 'mdxJsxAttribute') return undefined
  const value = values[0].value
  if (value === null || typeof value === 'string') return value
  if (!value || typeof value !== 'object') return undefined
  const expression = value as {data?: {estree?: {body?: Array<{expression?: {type?: string; value?: unknown}}>}}}
  const body = expression.data?.estree?.body
  const item = body?.length === 1 ? body[0].expression : undefined
  return item?.type === 'Literal' && ['string', 'number', 'boolean'].includes(typeof item.value) ? item.value as string | number | boolean : undefined
}
const stringLiteral = (node: Node, name: string) => {const value = literal(node, name); return typeof value === 'string' ? value : undefined}
function needsSnapshot(node: Node): boolean {
  if (node.type === 'mdxFlowExpression' || node.type === 'mdxTextExpression') return Boolean(node.value?.trim() && !/^\s*\/\*[\s\S]*\*\/\s*$/.test(node.value))
  if (node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') {
    const name = node.name ?? ''
    if (['Document', 'Drawing', 'Diagram', 'img'].includes(name)) return false
    if (name && !knownBuiltins.has(name) && !semanticTags.has(name) && !containers.has(name) && !['b', 'i', 'form', 'summary'].includes(name)) return true
    if (node.attributes?.some(attr => ['title', 'name'].includes(attr.name ?? '') && literal(node, attr.name!) === undefined)) return true
  }
  return (node.children ?? []).some(needsSnapshot)
}

class Converter {
  diagnostics: NotionHtmlDiagnostic[] = []
  definitions = new Map<string, Node>()
  constructor(readonly options: NotionHtmlOptions) {}

  range(node?: Node): NotionSourceRange {
    const bom = this.options.source.startsWith('\ufeff') ? 1 : 0
    return {sourcePath: this.options.path, from: (node?.position?.start.offset ?? 0) + bom,
      to: (node?.position?.end.offset ?? this.options.source.length - bom) + bom}
  }
  diagnose(kind: NotionHtmlDiagnostic['kind'], message: string, node?: Node): void {
    this.diagnostics.push({kind, message, ...this.range(node)})
  }
  source(node: Node): string {const {from, to} = this.range(node); return this.options.source.slice(from, to)}
  hasInvalidResource(node: Node): boolean {
    const name = node.name, src = stringLiteral(node, 'src'), attrs = node.attributes ?? []
    if (name === 'img' && (src === undefined || attrs.some(attr => attr.type !== 'mdxJsxAttribute') || node.children?.length)) return true
    if (name === 'Drawing' || name === 'Diagram') {
      if (!src || attrs.length !== 1 || node.children?.length || !this.source(node).trimEnd().endsWith('/>') || !projectPath(src) ||
        !(name === 'Drawing' ? /\.(?:excalidraw|excalidraw\.md)$/i : /\.d2$/i).test(src)) return true
    }
    if (name === 'Document') {
      const collapsed = attrs.some(attr => attr.name === 'defaultCollapsed') ? literal(node, 'defaultCollapsed') : false
      if (!src || !isDocumentPath(src) || node.children?.length || !this.source(node).trimEnd().endsWith('/>') ||
        attrs.some(attr => attr.type !== 'mdxJsxAttribute' || !['src', 'title', 'defaultCollapsed'].includes(attr.name ?? '')) ||
        new Set(attrs.map(attr => attr.name)).size !== attrs.length ||
        attrs.some(attr => attr.name === 'title' && stringLiteral(node, 'title') === undefined) ||
        !(collapsed === null || typeof collapsed === 'boolean')) return true
    }
    return (node.children ?? []).some(child => this.hasInvalidResource(child))
  }
  async children(node: Node): Promise<string> {
    const rendered: string[] = []
    for (const child of node.children ?? []) rendered.push(await this.render(child))
    return rendered.join('')
  }
  link(href: string, body: string, title?: string, node?: Node): string {
    let rewritten: string | null
    try {rewritten = this.options.rewriteLink ? this.options.rewriteLink(href, this.options.path) : href} catch {rewritten = null}
    if (!rewritten || !safeLink(rewritten)) {
      this.diagnose('unsafe-url', `The link ${href} could not be exported safely.`, node)
      return body
    }
    return `<a href="${escape(rewritten)}"${title ? ` title="${escape(title)}"` : ''}>${body}</a>`
  }
  async asset(node: Node, kind: NotionAssetReference['kind'], src: string, alt: string, title?: string): Promise<string> {
    try {
      const image = await this.options.resolveAsset?.({...this.range(node), kind, src, alt, ...(title ? {title} : {})})
      abort(this.options.signal)
      if (image && safeImage(image.src)) return imageTag(image, alt)
    } catch (error) {abort(this.options.signal, error)}
    this.diagnose('missing-asset', `The ${kind} ${src} was not included in the export.`, node)
    return `<span>[${escape(alt || `${kind}: ${src}`)} unavailable]</span>`
  }
  async snapshot(node: Node): Promise<string | null> {
    const source = this.source(node)
    try {
      const snapshot = await this.options.snapshot?.({...this.range(node), source})
      abort(this.options.signal)
      if (snapshot && 'src' in snapshot && safeImage(snapshot.src)) return imageTag(snapshot, `Static preview of ${node.name ?? 'expression'}`)
      if (snapshot && 'html' in snapshot) {
        const result = await sanitizeNotionHtml(snapshot.html, {...this.range(node), path: this.options.path, rewriteLink: this.options.rewriteLink, raster: this.options.raster, vector: this.options.vector, signal: this.options.signal})
        this.diagnostics.push(...result.diagnostics)
        if (result.html.trim()) return result.html
      }
    } catch (error) {abort(this.options.signal, error)}
    return null
  }
  async unsupported(node: Node, message: string, allowSnapshot = true): Promise<string> {
    if (allowSnapshot && !this.hasInvalidResource(node)) {
      const snapshot = await this.snapshot(node)
      if (snapshot !== null) return snapshot
    }
    const source = this.source(node)
    this.diagnose('unsupported', message, node)
    const label = `<span>[${escape(node.name ?? 'MDX expression')} could not be rendered; source follows]</span>`
    const code = `<code>${escape(source || node.value || node.name || node.type)}</code>`
    return node.type === 'mdxJsxTextElement' || node.type === 'mdxTextExpression' ? `${label}${code}` : `<div>${label}<pre>${code}</pre></div>`
  }

  async html(value: string, node?: Node, snapshot = false): Promise<string> {
    abort(this.options.signal)
    let root: HtmlNode
    try {
      // xmldom parses inert strings in Bun/browser alike; it never instantiates
      // browser images, executes scripts, fetches external entities or makes requests.
      const document = new DOMParser({onError: () => {throw new Error('Invalid HTML')}})
        .parseFromString(`<div>${value}</div>`, 'text/html')
      root = document.documentElement as unknown as HtmlNode
      if (document.doctype) throw new Error('HTML declarations are not supported')
    } catch {
      this.diagnose('parse', snapshot ? 'A component preview could not be converted safely.' : 'Some HTML could not be converted and is shown as text.', node)
      if (snapshot) return '<span>[Component preview could not be converted]</span>'
      return `<pre><code>${escape(value)}</code></pre>`
    }
    const visit = async (item: HtmlNode): Promise<string> => {
      abort(this.options.signal)
      if (item.nodeType === 3) return escape(item.nodeValue ?? '')
      if (item.nodeType !== 1) return ''
      let tag = item.nodeName.toLowerCase()
      const attr = (key: string) => item.getAttribute?.(key) ?? undefined
      if (item.hasAttribute?.('hidden') || attr('aria-hidden') === 'true' || /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!important\s*)?(?:;|$)/i.test(attr('style') ?? '')) return ''
      if (snapshot && tag === 'svg' && this.options.vector) {
        try {
          // Only an inert clone enters the trusted rasterizer. Validation here
          // also refuses active/network SVG before any callback can decode it.
          const markup = vectorMarkup(item as unknown as XmlElement)
          const bytes = new TextEncoder().encode(markup)
          if (bytes.length > MAX_IMAGE_BYTES) throw new Error('The component graphic exceeds 5 MiB.')
          inspectImage(bytes, 'image/svg+xml')
          const resolved = await this.options.vector(markup)
          abort(this.options.signal)
          if (!resolved.startsWith('data:') && safeImage(resolved)) return imageTag({src: resolved}, 'Component graphic')
        } catch (error) {abort(this.options.signal, error)}
        this.diagnose('missing-asset', 'A component graphic could not be included as a safe image.', node)
        return '<span>[Component graphic unavailable]</span>'
      }
      if (blocked.has(tag)) {
        this.diagnose('unsupported', `The ${tag} element was omitted from static HTML.`, node)
        return `<span>[${escape(tag)} omitted]</span>`
      }
      if (controls.has(tag)) {
        this.diagnose('unsupported', 'Interactive form fields were replaced; entered values were omitted.', node)
        return tag === 'option' || tag === 'optgroup' || tag === 'datalist' ? '' : `<span>[${tag === 'textarea' ? 'Text area' : tag === 'select' ? 'Selection' : 'Input'}]</span>`
      }
      if (tag === 'img') {
        const src = attr('src') ?? '', alt = attr('alt') ?? ''
        if (snapshot) {
          if (rasterDataImage(src)) {
            try {
              const resolved = this.options.raster ? await this.options.raster(src) : src
              abort(this.options.signal)
              if (safeImage(resolved)) return imageTag({src: resolved}, alt)
            } catch (error) {abort(this.options.signal, error)}
          }
          this.diagnose('missing-asset', 'A snapshot image was omitted because it was not a bounded static raster.', node)
          return `<span>[${escape(alt || 'Image')} unavailable]</span>`
        }
        return this.asset(node ?? {type: 'html'}, 'image', src, alt, attr('title'))
      }
      const parts: string[] = []
      for (let i = 0; i < item.childNodes.length; i++) {const child = item.childNodes.item(i); if (child) parts.push(await visit(child))}
      const body = parts.join('')
      if (tag === 'a') return this.link(attr('href') ?? '', body, attr('title'), node)
      if (tag === 'b') tag = 'strong'
      if (tag === 'i') tag = 'em'
      if (tag === 'summary') return `<p><strong>${body}</strong></p>`
      if (tag === 'form') return body
      if (containers.has(tag)) return ['span', 'label', 'button'].includes(tag) ? `<span>${body}</span>` : `<div>${body}</div>`
      if (!semanticTags.has(tag)) {
        this.diagnose('unsupported', `The ${tag} element was flattened to its readable content.`, node)
        return body || `<span>[${escape(tag)} unavailable]</span>`
      }
      let attributes = ''
      if (tag === 'ol' && /^\d{1,9}$/.test(attr('start') ?? '')) attributes = ` start="${Number(attr('start'))}"`
      if ((tag === 'td' || tag === 'th')) for (const name of ['colspan', 'rowspan']) {
        const value = Number(attr(name)); if (Number.isInteger(value) && value > 0 && value <= 100) attributes += ` ${name}="${value}"`
      }
      return tag === 'br' || tag === 'hr' ? `<${tag} />` : `<${tag}${attributes}>${body}</${tag}>`
    }
    // The wrapper itself is not output, and cannot add document-owned attributes.
    const result: string[] = []
    for (let i = 0; i < root.childNodes.length; i++) {const child = root.childNodes.item(i); if (child) result.push(await visit(child))}
    return result.join('')
  }

  async jsx(node: Node): Promise<string> {
    const name = node.name ?? ''
    if (!name) return this.children(node)
    if (node.attributes?.some(attr => attr.name === 'hidden') && literal(node, 'hidden') === undefined)
      return this.unsupported(node, 'This element has a computed visibility state.')
    if (node.attributes?.some(attr => attr.name === 'hidden') && literal(node, 'hidden') !== false ||
      ['true', true].includes(literal(node, 'aria-hidden') as string | boolean)) return ''
    const src = stringLiteral(node, 'src')
    if (name === 'Document') {
      const attrs = node.attributes ?? []
      const title = stringLiteral(node, 'title')
      const collapsed = attrs.some(attr => attr.name === 'defaultCollapsed') ? literal(node, 'defaultCollapsed') : false
      const valid = src && isDocumentPath(src) && !(node.children?.length) && this.source(node).trimEnd().endsWith('/>') &&
        attrs.every(attr => attr.type === 'mdxJsxAttribute' && ['src', 'title', 'defaultCollapsed'].includes(attr.name ?? '')) &&
        new Set(attrs.map(attr => attr.name)).size === attrs.length &&
        (!attrs.some(attr => attr.name === 'title') || title !== undefined) && (collapsed === null || typeof collapsed === 'boolean')
      if (!valid) return this.unsupported(node, 'This document reference is not a supported literal embed.', false)
      try {
        const result = await this.options.resolveDocument?.({...this.range(node), src, ...(title ? {title} : {})})
        abort(this.options.signal)
        if (result) {this.diagnostics.push(...result.diagnostics); return `<section>${title ? `<h2>${escape(title)}</h2>` : ''}${result.html}</section>`}
      } catch (error) {abort(this.options.signal, error)}
      this.diagnose('missing-asset', `The embedded document ${src} was not included.`, node)
      return `<p>[${escape(title || src)} unavailable]</p>`
    }
    if (name === 'Drawing' || name === 'Diagram') {
      if (!src || node.attributes?.length !== 1 || node.children?.length ||
        !this.source(node).trimEnd().endsWith('/>') || !projectPath(src) ||
        !(name === 'Drawing' ? /\.(?:excalidraw|excalidraw\.md)$/i : /\.d2$/i).test(src))
        return this.unsupported(node, `This ${name} reference is not a supported literal embed.`, false)
      return this.asset(node, name === 'Drawing' ? 'drawing' : 'diagram', src, name)
    }
    if (name === 'img') {
      if (src === undefined || node.attributes?.some(attr => attr.type !== 'mdxJsxAttribute') || node.children?.length)
        return this.unsupported(node, 'This image uses a computed reference.', false)
      return this.asset(node, 'image', src, stringLiteral(node, 'alt') ?? '', stringLiteral(node, 'title'))
    }
    // The editor captures whole islands, so a built-in wrapping a custom child
    // must use that outer snapshot before looking for unavailable child ranges.
    if (knownBuiltins.has(name) && needsSnapshot(node) && !this.hasInvalidResource(node)) {
      const snapshot = await this.snapshot(node)
      if (snapshot !== null) return snapshot
    }
    const titled = ['Note', 'Warning', 'Important', 'Callout', 'ExampleCard', 'Tab'].includes(name)
    const titleName = name === 'Tab' ? 'name' : 'title'
    const title = stringLiteral(node, titleName)
    if (titled && node.attributes?.some(attr => attr.name === titleName) && title === undefined)
      return this.unsupported(node, `The ${name} title needs a rendered snapshot.`)
    if (['Note', 'Warning', 'Important', 'Callout'].includes(name)) {
      return `<blockquote><p><strong>${escape(title ?? (name === 'Callout' ? 'Note' : name))}</strong></p>${await this.children(node)}</blockquote>`
    }
    if (name === 'Tab' || name === 'ExampleCard') return `<div>${title ? `<h3>${escape(title)}</h3>` : ''}${await this.children(node)}</div>`
    if (['CardTitle', 'AlertTitle'].includes(name)) return `<h3>${await this.children(node)}</h3>`
    if (name === 'Instruction.Action') {
      const step = literal(node, 'step')
      return `<div>${typeof step === 'number' ? `<p><strong>Step ${step}</strong></p>` : ''}${await this.children(node)}</div>`
    }
    if (blockBuiltins.has(name)) return `<div>${await this.children(node)}</div>`
    if (name === 'Badge' || name === 'Button') return `<span>${await this.children(node)}</span>`
    if (/^[a-z][a-z\d]*$/.test(name)) {
      if (blocked.has(name)) {this.diagnose('unsupported', `The ${name} element was omitted from static HTML.`, node); return `<span>[${escape(name)} omitted]</span>`}
      if (controls.has(name)) {this.diagnose('unsupported', 'Interactive form fields were replaced; entered values were omitted.', node); return `<span>[Input]</span>`}
      if (semanticTags.has(name) || containers.has(name) || ['b', 'i', 'summary', 'form'].includes(name)) {
        const body = await this.children(node)
        if (name === 'a') return this.link(stringLiteral(node, 'href') ?? '', body, stringLiteral(node, 'title'), node)
        if (name === 'b' || name === 'i') return `<${name === 'b' ? 'strong' : 'em'}>${body}</${name === 'b' ? 'strong' : 'em'}>`
        if (name === 'summary') return `<p><strong>${body}</strong></p>`
        if (name === 'form') return body
        if (containers.has(name)) return ['span', 'label', 'button'].includes(name) ? `<span>${body}</span>` : `<div>${body}</div>`
        return name === 'br' || name === 'hr' ? `<${name} />` : `<${name}>${body}</${name}>`
      }
    }
    return this.unsupported(node, `The ${name || 'MDX'} component was exported as a static snapshot or visible source.`)
  }

  async render(node: Node): Promise<string> {
    abort(this.options.signal)
    const body = () => this.children(node)
    switch (node.type) {
      case 'root': return body()
      case 'text': return escape(node.value ?? '')
      case 'paragraph': {
        let inline = ''
        const groups: string[] = []
        const flush = () => {if (inline.trim()) groups.push(`<p>${inline}</p>`); inline = ''}
        for (const child of node.children ?? []) {
          if (child.name && flowTags.has(child.name)) {flush(); groups.push(await this.render(child))}
          else inline += await this.render(child)
        }
        flush()
        return groups.join('')
      }
      case 'heading': return `<h${node.depth}>${await body()}</h${node.depth}>`
      case 'strong': return `<strong>${await body()}</strong>`
      case 'emphasis': return `<em>${await body()}</em>`
      case 'delete': return `<del>${await body()}</del>`
      case 'inlineCode': return `<code>${escape(node.value ?? '')}</code>`
      case 'code': return `<pre><code${node.lang ? ` class="language-${escape(node.lang)}"` : ''}>${escape(node.value ?? '')}</code></pre>`
      case 'blockquote': return `<blockquote>${await body()}</blockquote>`
      case 'break': return '<br />'
      case 'thematicBreak': return '<hr />'
      case 'list': return `<${node.ordered ? 'ol' : 'ul'}${node.ordered && node.start !== undefined && node.start !== 1 ? ` start="${node.start}"` : ''}>${await body()}</${node.ordered ? 'ol' : 'ul'}>`
      case 'listItem': return `<li>${typeof node.checked === 'boolean' ? `<input type="checkbox" disabled="disabled"${node.checked ? ' checked="checked"' : ''} /> ` : ''}${await body()}</li>`
      case 'link': return this.link(node.url ?? '', await body(), node.title, node)
      case 'image': return this.asset(node, 'image', node.url ?? '', node.alt ?? '', node.title)
      case 'linkReference': case 'imageReference': {
        const definition = this.definitions.get(node.identifier?.toUpperCase() ?? '')
        if (!definition) return this.unsupported(node, 'A Markdown reference has no destination.')
        return node.type === 'imageReference' ? this.asset(node, 'image', definition.url ?? '', node.alt ?? '', definition.title)
          : this.link(definition.url ?? '', await body(), definition.title, node)
      }
      case 'definition': case 'yaml': case 'toml': case 'mdxjsEsm': return ''
      case 'table': {
        const rows = node.children ?? []
        const renderRow = async (row: Node, cell: string) => `<tr>${(await Promise.all((row.children ?? []).map(async item => `<${cell}>${await this.children(item)}</${cell}>`))).join('')}</tr>`
        return `<table>${rows[0] ? `<thead>${await renderRow(rows[0], 'th')}</thead>` : ''}<tbody>${(await Promise.all(rows.slice(1).map(row => renderRow(row, 'td')))).join('')}</tbody></table>`
      }
      case 'html': {
        if (this.options.format === 'md' && /^\s*<(?:Drawing|Diagram)\s/.test(node.value ?? '')) {
          try {
            const parsed = processor('mdx').parse(node.value ?? '') as Node
            const element = parsed.children?.[0]
            if (parsed.children?.length === 1 && element?.type === 'mdxJsxFlowElement') return this.jsx({...element, position: node.position})
          } catch { /* Invalid tags are safely represented by the HTML path. */ }
        }
        return this.html(node.value ?? '', node)
      }
      case 'mdxJsxFlowElement': case 'mdxJsxTextElement': return this.jsx(node)
      case 'mdxFlowExpression': case 'mdxTextExpression':
        if (/^\s*\/\*[\s\S]*\*\/\s*$/.test(node.value ?? '') || !node.value?.trim()) return ''
        return this.unsupported(node, 'An MDX expression needs a static snapshot or source fallback.')
      default: return this.unsupported(node, `The ${node.type} block needs a static snapshot or source fallback.`)
    }
  }
}

/** Parse source only. No component code, imports, expressions or event handlers execute. */
export async function notionHtml(options: NotionHtmlOptions): Promise<NotionHtmlResult> {
  const converter = new Converter(options)
  abort(options.signal)
  let tree: Node
  try {tree = processor(options.format).parse(options.source) as Node}
  catch {
    converter.diagnose('parse', 'The document could not be parsed; its source is shown instead.')
    return {html: `<pre><code>${escape(options.source)}</code></pre>`, diagnostics: converter.diagnostics}
  }
  if (options.format === 'md') {normalizeImageFigures(tree); normalizeHtmlPairs(tree)}
  const visit = (node: Node) => {
    if (node.type === 'definition' && node.identifier && !converter.definitions.has(node.identifier.toUpperCase())) converter.definitions.set(node.identifier.toUpperCase(), node)
    for (const child of node.children ?? []) visit(child)
  }
  visit(tree)
  return {html: await converter.render(tree), diagnostics: converter.diagnostics}
}

/**
 * Inert semantic HTML for a captured component. Only actual bounded static
 * raster data images survive; component-created URLs never authorize reads.
 * Form labels and button text remain, while values and executable content do not.
 */
export async function sanitizeNotionHtml(html: string, options: SanitizeNotionHtmlOptions = {}): Promise<NotionHtmlResult> {
  const converter = new Converter({source: html, path: options.path ?? '', format: 'md', rewriteLink: options.rewriteLink, raster: options.raster, vector: options.vector, signal: options.signal})
  const node: Node = {type: 'html', position: {start: {offset: options.from ?? 0}, end: {offset: options.to ?? html.length}}}
  return {html: await converter.html(html, node, true), diagnostics: converter.diagnostics}
}
