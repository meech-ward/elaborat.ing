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
// The one exception is the app's embeds, `<Drawing src="..." />` and
// `<Diagram src="..." />` with a literal src, the same form the app reads
// (src/features/workbench/refs.ts). Each becomes an empty
// `<figure class="embed" data-embed="N">` that the view fills with the
// drawing, and the note's embeds are listed in the order of N.

/** A drawing or diagram a note embeds, by its project-relative path. */
export type EmbedRef = { kind: 'drawing' | 'diagram'; path: string }

/** The parts of an mdast node this module reads. */
type Node = { type: string; value?: unknown; alt?: unknown; children?: Node[]; data?: Record<string, unknown> }

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

function transform(node: Node, embeds: EmbedRef[], root = false): void {
  const place = (refs: EmbedRef[]) =>
    refs.map((ref) => {
      embeds.push(ref)
      return embedNode(embeds.length - 1)
    })
  node.children = node.children?.flatMap((child): Node[] => {
    if (root && isModuleSyntax(child)) return []
    if (child.type === 'html') {
      const refs = embedsIn(String(child.value ?? ''))
      return refs ? place(refs) : [{ type: 'text', value: String(child.value ?? '') }]
    }
    // A tag written over several lines parses as a paragraph of inline HTML.
    if (child.type === 'paragraph' && child.children?.some((part) => part.type === 'html')) {
      const parts = child.children.filter((part) => !isBlank(part))
      const refs = parts.map((part) => (part.type === 'html' ? parseEmbedTag(String(part.value ?? '')) : null))
      if (refs.every((ref) => ref !== null)) return place(refs as EmbedRef[])
    }
    if (child.type === 'image' || child.type === 'imageReference') {
      return [{ type: 'text', value: typeof child.alt === 'string' ? child.alt : '' }]
    }
    transform(child, embeds)
    return [child]
  })
}

/** GitHub's schema plus the empty embed figures this module places. */
const schema: Schema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), 'figure'],
  attributes: { ...defaultSchema.attributes, figure: [['className', 'embed'], 'dataEmbed'] },
}

/** A note's sanitized HTML and the drawings and diagrams it embeds, in order. */
export function renderNote(source: string): { html: string; embeds: EmbedRef[] } {
  const embeds: EmbedRef[] = []
  const processor = unified()
    .use(remarkParse)
    .use(remarkFrontmatter, ['yaml', 'toml'])
    .use(remarkGfm)
    .use(() => (tree) => transform(tree as Node, embeds, true))
    .use(remarkRehype)
    .use(rehypeSanitize, schema)
    .use(rehypeStringify)
  return { html: String(processor.processSync(source)), embeds }
}

/** Markdown source to sanitized HTML. */
export function renderMarkdown(source: string): string {
  return renderNote(source).html
}
