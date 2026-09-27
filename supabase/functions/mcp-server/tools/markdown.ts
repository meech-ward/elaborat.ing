import rehypeSanitize from 'npm:rehype-sanitize@6.0.0'
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

/** The parts of an mdast node this module reads. */
type Node = { type: string; value?: unknown; alt?: unknown; children?: Node[] }

function rawHtmlAsText(node: Node): void {
  node.children = node.children?.map((child) => {
    if (child.type === 'html') return { type: 'text', value: String(child.value ?? '') }
    if (child.type === 'image' || child.type === 'imageReference') {
      return { type: 'text', value: typeof child.alt === 'string' ? child.alt : '' }
    }
    rawHtmlAsText(child)
    return child
  })
}

const processor = unified()
  .use(remarkParse)
  .use(remarkFrontmatter, ['yaml', 'toml'])
  .use(remarkGfm)
  .use(() => (tree) => rawHtmlAsText(tree as Node))
  .use(remarkRehype)
  .use(rehypeSanitize)
  .use(rehypeStringify)
  .freeze()

/** Markdown source to sanitized HTML. */
export function renderMarkdown(source: string): string {
  return String(processor.processSync(source))
}
