import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkMdx from 'remark-mdx'
import remarkGfm from 'remark-gfm'
import remarkFrontmatter from 'remark-frontmatter'
import { parseImageReferences } from '../../../src/features/images/referenceParser.ts'

type Node = { type?: string; [key: string]: unknown }
export type Reference = { path: string; kind: 'document' | 'module' | 'drawing' | 'diagram' | 'image' }

/** Raw identities, never URLs or dot segments. All database reads also bind the project. */
export function safePath(path: string): boolean {
  return path.length > 0 && path.length <= 512 && path.normalize('NFC') === path &&
    new TextEncoder().encode(path).length <= 1024 &&
    !/[\\:\u0000-\u001f\u007f-\u009f]/.test(path) &&
    path.split('/').every(part => part.length > 0 && !part.startsWith('.'))
}

const md = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter)
const mdx = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter).use(remarkMdx)
const documentPath = (path: string) => safePath(path) && /\.(?:md|mdx)$/i.test(path) && !/\.excalidraw\.md$/i.test(path)
const resourcePath = (name: string, path: string) => safePath(path) &&
  (name === 'Drawing' ? /\.(?:excalidraw|excalidraw\.md)$/i.test(path) : /\.d2$/i.test(path))

function walk(value: unknown, visit: (node: Node) => void): void {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) { for (const item of value) walk(item, visit); return }
  const node = value as Node
  if (typeof node.type === 'string') visit(node)
  for (const [key, child] of Object.entries(node)) if (!['loc', 'position', 'range'].includes(key)) walk(child, visit)
}

/**
 * Parse saved syntax, never evaluated component output. Ordinary links, strings,
 * code fences, comments, expressions and spread props do not grant file access.
 */
export async function renderingReferences(source: string, path: string): Promise<Reference[]> {
  const format = /\.mdx$/i.test(path) ? 'mdx' : 'md'
  const refs = new Map<string, Reference>()
  const add = (kind: Reference['kind'], candidate: unknown) => {
    if (typeof candidate === 'string' && safePath(candidate)) refs.set(`${kind}\0${candidate}`, { kind, path: candidate })
  }
  const inspect = (node: Node, syntax = source) => {
    if (node.type === 'ImportDeclaration') {
      const specifier = (node.source as Node | undefined)?.value
      const specs = node.specifiers as Node[] | undefined
      if (typeof specifier === 'string' && specifier.startsWith('workspace:') &&
        specs?.length && specs.every(spec => spec.type === 'ImportSpecifier')) {
        const target = specifier.slice(10)
        if (/\.mdx$/i.test(target)) add('module', target)
      }
    }
    if (node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') {
      const name = node.name
      if (!['Document', 'Drawing', 'Diagram'].includes(String(name))) return
      const attrs = (node.attributes ?? []) as Node[]
      const sources = attrs.filter(attr => attr.name === 'src')
      const position = node.position as { start?: { offset?: number }; end?: { offset?: number } } | undefined
      const from = position?.start?.offset, to = position?.end?.offset
      const bom = syntax.startsWith('\ufeff') ? 1 : 0
      if (sources.length !== 1 || typeof sources[0].value !== 'string' ||
        attrs.some(attr => attr.type !== 'mdxJsxAttribute') || (node.children as unknown[] | undefined)?.length ||
        from === undefined || to === undefined || !syntax.slice(from + bom, to + bom).endsWith('/>')) return
      const target = sources[0].value
      if (name === 'Document') {
        // Match the app's strict Document shell; only literal presentation props.
        if (attrs.some(attr => !['src', 'title', 'defaultCollapsed'].includes(String(attr.name)))) return
        const title = attrs.filter(attr => attr.name === 'title')
        const collapsed = attrs.filter(attr => attr.name === 'defaultCollapsed')
        if (title.length > 1 || title.some(attr => typeof attr.value !== 'string') || collapsed.length > 1) return
        if (collapsed.length && collapsed[0].value !== null) {
          const value = collapsed[0].value as Node
          const body = ((value.data as Node | undefined)?.estree as Node | undefined)?.body as Node[] | undefined
          const expression = body?.length === 1 ? body[0].expression as Node | undefined : undefined
          if (expression?.type !== 'Literal' || typeof expression.value !== 'boolean') return
        }
        if (documentPath(target)) add('document', target)
      } else if (attrs.length === 1 && resourcePath(String(name), target)) add(name === 'Drawing' ? 'drawing' : 'diagram', target)
    }
    // Static images inside exported component bodies are handled by the shared
    // image parser. Literal drawing/diagram bodies use the same restriction.
    if (node.type === 'JSXElement') {
      const opening = node.openingElement as Node
      const name = (opening?.name as Node | undefined)?.name
      const attrs = opening?.attributes as Node[] | undefined
      if (!['Drawing', 'Diagram'].includes(String(name)) || !opening.selfClosing || attrs?.length !== 1) return
      const attr = attrs[0]
      const value = attr.value as Node | undefined
      if (attr.type === 'JSXAttribute' && (attr.name as Node)?.name === 'src' && value?.type === 'Literal' &&
        typeof value.value === 'string' && resourcePath(String(name), value.value)) add(name === 'Drawing' ? 'drawing' : 'diagram', value.value)
    }
  }
  const tree = (format === 'mdx' ? mdx : md).parse(source)
  walk(tree, node => {
    inspect(node)
    // Markdown permits the existing literal drawing/diagram embed tags, but a
    // Document is an MDX-only component. Parse HTML as syntax, never scan code.
    if (format === 'md' && node.type === 'html' && typeof node.value === 'string') {
      try { walk(mdx.parse(node.value), child => { if (child.name !== 'Document') inspect(child, String(node.value)) }) } catch { /* plain HTML */ }
    }
  })
  for (const image of await parseImageReferences(source, format, path)) add('image', image.path)
  return [...refs.values()]
}
