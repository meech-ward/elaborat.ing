import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkMdx from "remark-mdx";
import remarkGfm from "remark-gfm";
type DocumentFormat = "md" | "mdx";
import { imageReferenceKey, resolveImagePath } from "./referencePaths.ts";
import { normalizeImageFigures } from './figureNodes.ts';
export { imageReferenceKey, relativeImagePath, resolveImagePath } from "./referencePaths.ts";

type Node = {
  type: string; name?: string; value?: unknown; alt?: string; url?: string; identifier?: string;
  attributes?: Array<{type:string;name?:string;value?:unknown}>;
  children?: Node[]; data?: { estree?: unknown };
  position?: {start:{offset?:number};end:{offset?:number}};
  [key: string]: unknown;
};
export type ImageReference = {
  src: string; path: string; key: string; alt: string;
  sourcePath: string; from: number; to: number;
  kind: "markdown" | "reference" | "jsx" | "html";
  /** A reference-style definition's own destination range; callers can still remove only this usage. */
  definition?: { from: number; to: number };
  figure?: {from:number;to:number;captionFrom:number;captionTo:number;caption:string};
};
const extent = (node: Node) => {
  const from = node.position?.start.offset, to = node.position?.end.offset;
  return from === undefined || to === undefined ? null : {from,to};
};
function walk(node: Node, visit: (node: Node) => void) {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}
const parser = (format: DocumentFormat) => {
  const processor = unified().use(remarkParse).use(remarkGfm);
  return format === "mdx" ? processor.use(remarkMdx) : processor;
};
function staticAttributes(node: Node): {src:string;alt:string} | null {
  if (node.name !== "img") return null;
  const attrs = node.attributes ?? [];
  if (attrs.some(attr => attr.type !== "mdxJsxAttribute")) return null;
  const sources = attrs.filter(attr => attr.name === "src");
  const alts = attrs.filter(attr => attr.name === "alt");
  if (sources.length !== 1 || typeof sources[0].value !== "string" || alts.length > 1 || (alts.length === 1 && typeof alts[0].value !== "string")) return null;
  return {src:sources[0].value,alt:alts[0]?.value as string ?? ""};
}
/** A Markdown HTML node is parsed as one literal MDX image tag, never by scanning document text. */
export function literalHtmlImage(value: string): {src:string;alt:string} | null {
  if (!/^<img\s/i.test(value.trim()) || !/>$/.test(value.trim())) return null;
  const tag = value.trim().replace(/\/?\s*>$/, " />");
  try {
    const tree = parser("mdx").parse(tag) as Node;
    const first = tree.children?.[0];
    const element = first?.type === "paragraph" ? first.children?.[0] : first;
    if (!element || (element.children?.length ?? 0) > 0 || tree.children?.length !== 1) return null;
    return staticAttributes(element);
  } catch { return null; }
}

/** Parse only actual image syntax. Code, comments, links and computed JSX never grant asset access. */
export async function parseImageReferences(
  source: string,
  format: DocumentFormat,
  notePath: string,
  modules: readonly {path:string;source?:string;text?:string;esm?:string}[] = [],
): Promise<ImageReference[]> {
  const refs: ImageReference[] = [];
  const collect = (text: string, sourcePath: string, ownFormat: DocumentFormat, modulePath: string | null) => {
    const bom = text.startsWith('\ufeff') ? 1 : 0;
    const sourceRange = (node:Node) => {const bounds = extent(node);return bounds ? {from:bounds.from+bom,to:bounds.to+bom} : null;};
    const tree = parser(ownFormat).parse(text) as Node;
    if (ownFormat === 'md') normalizeImageFigures(tree);
    const definitions = new Map<string,Node>();
    walk(tree, node => { if (node.type === "definition" && node.identifier && !definitions.has(node.identifier)) definitions.set(node.identifier,node); });
    const add = (node:Node, src:string, alt:string, kind:ImageReference["kind"], definition?:Node) => {
      const range = sourceRange(node), path = resolveImagePath(sourcePath,src);
      if (!range || !path) return;
      refs.push({...range,src,path,key:imageReferenceKey(modulePath,src),alt,kind,sourcePath,...(definition && sourceRange(definition) ? {definition:sourceRange(definition)!} : {})});
    };
    walk(tree,node => {
      if (node.type === "image" && node.url) add(node,node.url,node.alt ?? "","markdown");
      if (node.type === "imageReference") {
        const definition = definitions.get(node.identifier ?? "");
        if (definition?.url) add(node,definition.url,node.alt ?? "","reference",definition);
      }
      if (node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement") {
        const attrs = staticAttributes(node);
        if (attrs) add(node,attrs.src,attrs.alt,"jsx");
      }
      if (node.type === "html" && typeof node.value === "string") {
        const attrs = literalHtmlImage(node.value);
        if (attrs) add(node,attrs.src,attrs.alt,"html");
      }
      // Exported component bodies are parser-owned ESTree, not document text.
      const inspectJsx = (value: unknown) => {
        if (!value || typeof value !== "object") return;
        if (Array.isArray(value)) { for (const item of value) inspectJsx(item); return; }
        const ast = value as Record<string,unknown>;
        if (ast.type === "JSXElement") {
          const opening = ast.openingElement as Record<string,unknown>;
          const name = opening.name as Record<string,unknown>;
          const attrs = opening.attributes as Array<Record<string,unknown>>;
          if (name.type === "JSXIdentifier" && name.name === "img" && attrs.every(attr => attr.type === "JSXAttribute")) {
            const srcs = attrs.filter(attr => (attr.name as Record<string,unknown>)?.name === "src");
            const alts = attrs.filter(attr => (attr.name as Record<string,unknown>)?.name === "alt");
            const src = srcs[0]?.value as Record<string,unknown> | undefined;
            const alt = alts[0]?.value as Record<string,unknown> | undefined;
            if (srcs.length === 1 && src?.type === "Literal" && typeof src.value === "string" && alts.length <= 1 && (!alt || alt.type === "Literal" && typeof alt.value === "string")) {
              const start = ast.start, end = ast.end;
              if (typeof start === "number" && typeof end === "number")
                add({type:"jsx",position:{start:{offset:start},end:{offset:end}}},src.value,String(alt?.value ?? ""),"jsx");
            }
          }
        }
        for (const [key,item] of Object.entries(ast)) if (!["loc","position","range"].includes(key)) inspectJsx(item);
      };
      if (node.data?.estree) inspectJsx(node.data.estree);
    });
    walk(tree,node => {
      if (node.name !== 'figure') return;
      const bounds = sourceRange(node);
      const caption = node.children?.find(child => child.name === 'figcaption');
      const rawFrom = caption?.children?.[0]?.position?.start.offset;
      const rawTo = caption?.children?.at(-1)?.position?.end.offset;
      if (!bounds || rawFrom === undefined || rawTo === undefined) return;
      const from = rawFrom + bom,to = rawTo + bom;
      const images = refs.filter(reference => reference.sourcePath === sourcePath && reference.from > bounds.from && reference.to < bounds.to);
      if (images.length === 1) images[0].figure = {...bounds,captionFrom:from,captionTo:to,caption:text.slice(from,to)};
    });
  };
  collect(source,notePath,format,null);
  for (const module of modules) collect(module.source ?? module.text ?? module.esm ?? "",module.path,"mdx",module.path);
  return refs;
}
