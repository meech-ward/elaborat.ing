import rehypeSanitize, { defaultSchema, type Options as Schema } from 'npm:rehype-sanitize@6.0.0'
import rehypeStringify from 'npm:rehype-stringify@10.0.1'
import remarkFrontmatter from 'npm:remark-frontmatter@5.0.0'
import remarkGfm from 'npm:remark-gfm@4.0.1'
import remarkParse from 'npm:remark-parse@11.0.0'
import remarkRehype from 'npm:remark-rehype@11.1.2'
import { unified } from 'npm:unified@11.0.5'

// Renders a note to HTML for the read-only file view. Markdown and GFM only:
// raw HTML and MDX tags in the source are shown as text, never as markup,
// images become their alt text (the view cannot load them), and the result
// goes through rehype-sanitize's GitHub schema, which also drops links that
// are not http(s), mailto or relative.
//
// The exceptions are the app's embeds, `<Drawing src="..." />` and
// `<Diagram src="..." />` with a literal src, the same form the app reads
// (src/features/workbench/refs.ts), and its callouts. Each embed becomes an
// empty `<figure class="embed" data-embed="N">` that the view fills with the
// drawing, and the note's embeds are listed in the order of N. A
// `<Callout>` at the start of a block, with a string tone and title if any
// (`tone="warn"`, or `tone={"warn"}`), becomes `<aside class="callout"
// data-tone="info|warn|error">` around its Markdown up to its closing tag,
// blank lines included, as the app renders it
// (src/features/rendered/components.tsx); the view draws it as a callout.
//
// A note whose MDX goes further (imports and exports, other components,
// HTML, or expressions in braces) is marked `mdx`: the view previews it with
// the app's components (fileView.ts sends it the component files it needs).

/** A drawing or diagram a note embeds, by its project-relative path. */
export type EmbedRef = { kind: 'drawing' | 'diagram'; path: string }

/** What rendering found: the embeds in order, and whether any MDX showed as text or was left out. */
type Found = { embeds: EmbedRef[]; mdx: boolean }

/** The parts of an mdast node this module reads. */
type Node = {
  type: string
  value?: unknown
  alt?: unknown
  children?: Node[]
  data?: Record<string, unknown>
  position?: { start: { offset?: number }; end: { offset?: number } }
}

const EMBED_TAG = /^<(Drawing|Diagram)\s+src=(?:"([^"]{1,4096})"|'([^']{1,4096})')\s*\/>$/

/** The entities the app's literal editor writes, decoded once as JSX does. */
function decodeLiteral(raw: string): string {
  const entities: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", '#10': '\n', '#13': '\r',
  }
  return raw.replace(/&(amp|lt|gt|quot|apos|#39|#10|#13);/g, (_match, entity: string) => entities[entity])
}

/** The embed a whole tag is, or null for anything else. */
export function parseEmbedTag(tag: string): EmbedRef | null {
  const match = EMBED_TAG.exec(tag.trim())
  if (!match) return null
  const path = decodeLiteral(match[2] ?? match[3] ?? '')
  if (!path || path.startsWith('/') || path.split('/').some((part) => part === '' || part === '.' || part === '..')) return null
  return { kind: match[1] === 'Diagram' ? 'diagram' : 'drawing', path }
}

/** The embeds an HTML node holds when it is nothing but embed tags, one per line. */
function embedsIn(value: string): EmbedRef[] | null {
  const whole = parseEmbedTag(value)
  if (whole) return [whole]
  const refs = value.split('\n').filter((line) => line.trim()).map(parseEmbedTag)
  return refs.length > 0 && refs.every((ref) => ref !== null) ? (refs as EmbedRef[]) : null
}

const isBlank = (node: Node) => node.type === 'text' && String(node.value ?? '').trim() === ''

function embedNode(index: number): Node {
  return { type: 'embed', data: { hName: 'figure', hProperties: { className: ['embed'], dataEmbed: String(index) } } }
}

const textOf = (node: Node): string =>
  node.type === 'text' ? String(node.value ?? '') : (node.children ?? []).map(textOf).join('')

/** MDX's import and export lines: code for the app, not part of what the note says. */
const isModuleSyntax = (node: Node) => node.type === 'paragraph' && /^(import|export)\s/.test(textOf(node))

// A string prop: "x", 'x', {"x"} or {'x'}.
const CALLOUT = /^<Callout((?:\s+[A-Za-z][\w-]*=(?:"[^"]*"|'[^']*'|\{"[^"]*"\}|\{'[^']*'\}))*)\s*>([\s\S]*?)<\/Callout>$/
const ATTRIBUTE = /([A-Za-z][\w-]*)=(?:"([^"]*)"|'([^']*)'|\{"([^"]*)"\}|\{'([^']*)'\})/g
/** A block that opens a callout and does not close it: a blank line comes before its closing tag. */
const OPENS_CALLOUT = /^<Callout[\s>]/
/** Nodes whose children are blocks, where a callout can span several. */
const BLOCKS = new Set(['root', 'blockquote', 'listItem'])

/** The text with the indent its lines share taken off, as MDX reads a component's children. */
function dedent(text: string): string {
  const lines = text.replace(/^\n+|\s+$/g, '').split('\n')
  const indent = Math.min(...lines.filter((line) => line.trim()).map((line) => /^[ \t]*/.exec(line)![0].length))
  return lines.map((line) => line.slice(Number.isFinite(indent) ? indent : 0)).join('\n')
}

/** A whole `<Callout ...>...</Callout>` as an aside around its Markdown, or null for anything else. */
function calloutNode(raw: string, found: Found): Node | null {
  const match = CALLOUT.exec(raw.trim())
  if (!match) return null
  const attributes = new Map(
    [...match[1].matchAll(ATTRIBUTE)].map((found) => [found[1], decodeLiteral(found[2] ?? found[3] ?? found[4] ?? found[5] ?? '')])
  )
  const tone = attributes.get('tone')
  const title = attributes.get('title')
  const body = dedent(match[2])
  const tree = unified().use(remarkParse).use(remarkGfm).parse(body) as Node
  transform(tree, found, false, body)
  const heading: Node[] = title
    ? [{ type: 'paragraph', data: { hProperties: { className: ['callout-title'] } }, children: [{ type: 'text', value: title }] }]
    : []
  return {
    type: 'callout',
    data: { hName: 'aside', hProperties: { className: ['callout'], dataTone: tone === 'warn' || tone === 'error' ? tone : 'info' } },
    children: [...heading, ...(tree.children ?? [])],
  }
}

/** The note's text for a node, from where the parser found it. */
function sourceOf(node: Node, source: string): string {
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  return start === undefined || end === undefined ? '' : source.slice(start, end)
}

/**
 * A callout with a blank line inside, which the parser splits into blocks:
 * from the one that opens it to the first that ends with its closing tag.
 * Returns the callout and how many blocks it took, or null.
 */
function spannedCallout(children: Node[], at: number, found: Found, source: string): [Node, number] | null {
  const opening = children[at]
  if (opening.type !== 'html' || !OPENS_CALLOUT.test(String(opening.value ?? '')) || String(opening.value).includes('</Callout>')) return null
  const end = children.findIndex((later, index) => index > at && /<\/Callout>\s*$/.test(sourceOf(later, source)))
  const from = opening.position?.start.offset
  const to = children[end]?.position?.end.offset
  if (end < 0 || from === undefined || to === undefined) return null
  const callout = calloutNode(source.slice(from, to), found)
  return callout ? [callout, end - at + 1] : null
}

function transform(node: Node, found: Found, root: boolean, source: string): void {
  const place = (refs: EmbedRef[]) =>
    refs.map((ref) => {
      found.embeds.push(ref)
      return embedNode(found.embeds.length - 1)
    })
  let skip = 0
  node.children = node.children?.flatMap((child, index, children): Node[] => {
    if (skip > 0) {
      skip--
      return []
    }
    if (root && isModuleSyntax(child)) {
      found.mdx = true
      return []
    }
    const spanned = BLOCKS.has(node.type) ? spannedCallout(children, index, found, source) : null
    if (spanned) {
      skip = spanned[1] - 1
      return [spanned[0]]
    }
    if (child.type === 'html') {
      const refs = embedsIn(String(child.value ?? ''))
      if (refs) return place(refs)
      const callout = calloutNode(String(child.value ?? ''), found)
      if (!callout) found.mdx = true
      return [callout ?? { type: 'text', value: String(child.value ?? '') }]
    }
    // A tag written over several lines, or a callout with its words on the
    // same line, parses as a paragraph of inline HTML.
    if (child.type === 'paragraph' && child.children?.some((part) => part.type === 'html')) {
      const parts = child.children.filter((part) => !isBlank(part))
      const refs = parts.map((part) => (part.type === 'html' ? parseEmbedTag(String(part.value ?? '')) : null))
      if (refs.every((ref) => ref !== null)) return place(refs as EmbedRef[])
      const callout = calloutNode(sourceOf(child, source), found)
      if (callout) return [callout]
    }
    // A tag with a JavaScript prop is not HTML to the parser, and an expression is text: both MDX all the same.
    if (child.type === 'text' && /<[A-Za-z]|\{/.test(String(child.value ?? ''))) found.mdx = true
    if (child.type === 'image' || child.type === 'imageReference') {
      return [{ type: 'text', value: typeof child.alt === 'string' ? child.alt : '' }]
    }
    transform(child, found, false, source)
    return [child]
  })
}

/** GitHub's schema plus the empty embed figures and the callouts this module places. */
const schema: Schema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), 'figure', 'aside'],
  attributes: {
    ...defaultSchema.attributes,
    figure: [['className', 'embed'], 'dataEmbed'],
    aside: [['className', 'callout'], ['dataTone', 'info', 'warn', 'error']],
    p: [...(defaultSchema.attributes?.p ?? []), ['className', 'callout-title']],
  },
}

/**
 * A note's sanitized HTML, the drawings and diagrams it embeds, in order,
 * and whether it has MDX the HTML shows as text or leaves out.
 */
export function renderNote(source: string): { html: string; embeds: EmbedRef[]; mdx: boolean } {
  const found: Found = { embeds: [], mdx: false }
  const processor = unified()
    .use(remarkParse)
    .use(remarkFrontmatter, ['yaml', 'toml'])
    .use(remarkGfm)
    .use(() => (tree) => transform(tree as Node, found, true, source))
    .use(remarkRehype)
    .use(rehypeSanitize, schema)
    .use(rehypeStringify)
  const html = String(processor.processSync(source))
  return { html, embeds: found.embeds, mdx: found.mdx }
}

/** Markdown source to sanitized HTML. */
export function renderMarkdown(source: string): string {
  return renderNote(source).html
}
