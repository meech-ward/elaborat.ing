import { createProcessor } from '@mdx-js/mdx';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import type { DocumentFormat } from './index';
import { isDocumentPath } from './documentPaths';

type Node = {
  type: string;
  name?: string;
  value?: unknown;
  children?: Node[];
  attributes?: Node[];
  data?: { estree?: { body?: { expression?: { type?: string; value?: unknown } }[] } };
  position?: { start: { offset?: number }; end: { offset?: number } };
};

export type DocumentReference = {
  path: string;
  title?: string;
  defaultCollapsed: boolean;
  /** Whole element source range, in UTF-16 code units of the authoritative note. */
  from: number;
  to: number;
};

const processor = createProcessor({ format: 'mdx', remarkPlugins: [remarkGfm, remarkFrontmatter] });

function booleanLiteral(attribute: Node): boolean | null {
  if (attribute.value === null) return true;
  if (typeof attribute.value !== 'object' || attribute.value === null) return null;
  const expression = attribute.value as Node;
  const body = expression.data?.estree?.body;
  const literal = body?.length === 1 ? body[0].expression : undefined;
  return literal?.type === 'Literal' && typeof literal.value === 'boolean' ? literal.value : null;
}

/** Only parser-proven, self-closing literal MDX tags grant document access.
 * Code, comments, frontmatter and executable JSX never produce references.
 * Invalid MDX throws so the caller can refuse authority rather than guess. */
export function parseDocumentReferences(source: string, format: DocumentFormat = 'mdx'): DocumentReference[] {
  if (format !== 'mdx') return [];
  const tree = processor.parse(source) as Node;
  const references: DocumentReference[] = [];
  // The parser strips a leading BOM before reporting positions.
  const bom = source.startsWith('\ufeff') ? 1 : 0;
  const walk = (node: Node) => {
    if ((node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') && node.name === 'Document') {
      const start = node.position?.start.offset, end = node.position?.end.offset;
      const from = start === undefined ? undefined : start + bom, to = end === undefined ? undefined : end + bom;
      const attrs = node.attributes ?? [];
      const sources = attrs.filter(attr => attr.name === 'src');
      const titles = attrs.filter(attr => attr.name === 'title');
      const collapsed = attrs.filter(attr => attr.name === 'defaultCollapsed');
      const valid = from !== undefined && to !== undefined && source.slice(from,to).endsWith('/>') &&
        (node.children?.length ?? 0) === 0 &&
        attrs.every(attr => attr.type === 'mdxJsxAttribute' && ['src','title','defaultCollapsed'].includes(attr.name ?? '')) &&
        sources.length === 1 && typeof sources[0].value === 'string' && isDocumentPath(sources[0].value) &&
        titles.length <= 1 && (!titles.length || typeof titles[0].value === 'string') &&
        collapsed.length <= 1 && (!collapsed.length || booleanLiteral(collapsed[0]) !== null);
      if (valid) references.push({
        path: sources[0].value as string,
        ...(titles.length ? { title: titles[0].value as string } : {}),
        defaultCollapsed: collapsed.length ? booleanLiteral(collapsed[0])! : false,
        from: from!, to: to!,
      });
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(tree);
  return references;
}
