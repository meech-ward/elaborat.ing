/**
 * Source-offset instrumentation for the rendered editor.
 *
 * The renderer never re-serializes the document. Instead it parses the real
 * source with the official MDX compiler (or the same compiler in `md`
 * format for plain `.md`, so markdown stays literal markdown and braces
 * never evaluate as expressions), records byte offsets for editable prose
 * leaves and literal component props, and builds checked
 * `{ from, to, insert, expected }` patches. Unrelated bytes (imports,
 * comments, formatting, other content) are never touched.
 */
import { compile } from "@mdx-js/mdx";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import { visit } from "unist-util-visit";
import {
  parseExpressionLiteral,
  type LiteralPropKind,
  type PropSyntax,
} from "./protocol";
import type { DocumentFormat } from "./types";
import { collectBlocks, type BlockMap } from "./blocks";
import { COMPONENT_CATALOG, type ComponentDefinition } from "../document/componentCatalog";
import { workspaceImportPlugin } from "../document/componentModules";
import { codeRegion, type CodeRegion } from './sourceRegions';
export { encodeTextLeaf } from './sourceRegions';

export type SourceRange = { from: number; to: number };

/** An editable run of prose with its exact source range. */
export type TextLeaf = SourceRange & { expected: string; literal?: boolean; code?: CodeRegion };

export type { LiteralPropKind };

export type LiteralProp = SourceRange & {
  name: string;
  kind: LiteralPropKind;
  /** Quoted (`title="..."`) or braced (`title={...}`) source context. */
  syntax: PropSyntax;
  expected: string;
  value: number | string | boolean;
};

export type ComponentSlot = SourceRange & {
  /** Stable index used as the `__slot` marker in preview compilation. */
  index: number;
  element: string;
  props: LiteralProp[];
  supported: boolean;
  /** Static invocation children can be editable even without literal prop controls. */
  editableChildren?: boolean;
  reason?: string;
};

export type Instrumentation = BlockMap & {
  leaves: TextLeaf[];
  components: ComponentSlot[];
};

type Positioned = {
  position?: {
    start: { offset?: number };
    end: { offset?: number };
  };
};

type MdxJsxAttribute =
  | { type: "mdxJsxExpressionAttribute"; value: string }
  | { type: "mdxJsxAttribute"; name: string; value: string | null | object }
  | { type: string; name?: string; value?: unknown };

type MdxJsxElement = Positioned & {
  type: string;
  name?: string;
  attributes?: MdxJsxAttribute[];
};

function offsets(node: Positioned): SourceRange | null {
  const from = node.position?.start.offset;
  const to = node.position?.end.offset;
  if (typeof from !== "number" || typeof to !== "number" || !(from < to))
    return null;
  return { from, to };
}

/** Literal source text for a new numeric prop value, e.g. `4`. */
export function numberLiteral(next: number): string {
  if (!Number.isFinite(next))
    throw new Error("Prop value must be a finite number.");
  return String(next);
}

/** Literal source text for a new braced string prop value, e.g. `"New title"`. */
export function stringLiteral(next: string): string {
  return JSON.stringify(next);
}

/** Literal source text for a new boolean prop value. */
export function booleanLiteral(next: boolean): string {
  return next ? "true" : "false";
}

function locateLiteral(
  source: string,
  attrFrom: number,
  attrTo: number,
): { inner: string; from: number; to: number; syntax: PropSyntax } | null {
  const slice = source.slice(attrFrom, attrTo);
  // Form: name="string" or name='string' or name={expression}.
  const quoted = /^[A-Za-z_$][\w$.-]*\s*=\s*("([^"]*)"|'([^']*)')/.exec(slice);
  if (quoted) {
    const full = quoted[1];
    const start = attrFrom + (quoted[0].length - full.length);
    return {
      inner: full,
      from: start,
      to: start + full.length,
      syntax: full.startsWith('"') ? "quoted-double" : "quoted-single",
    };
  }
  const braced = /^[A-Za-z_$][\w$.-]*\s*=\s*\{([\s\S]*)\}$/.exec(
    slice.trimEnd(),
  );
  if (braced) {
    const open = slice.indexOf("{");
    const close = slice.lastIndexOf("}");
    if (open === -1 || close === -1 || close <= open) return null;
    return {
      inner: slice.slice(open + 1, close),
      from: attrFrom + open + 1,
      to: attrFrom + close,
      syntax: "braced",
    };
  }
  return null;
}

/**
 * Extract literal props for one JSX element from source. Any attribute that
 * is not a plain number/string/boolean literal (spread, expression,
 * template, member access) makes the whole element unsupported: computed
 * output is identified, never silently rewritten.
 */
export function extractLiteralProps(
  source: string,
  element: string,
  attributes: MdxJsxAttribute[],
  attrRanges: SourceRange[],
): { props: LiteralProp[]; supported: boolean; reason?: string } {
  const props: LiteralProp[] = [];
  const names = new Set<string>();
  for (let i = 0; i < attributes.length; i++) {
    const attr = attributes[i];
    if (attr.type !== "mdxJsxAttribute" || typeof attr.name !== "string") {
      return {
        props: [],
        supported: false,
        reason: `<${element}> uses a spread or computed attribute; edit it in source.`,
      };
    }
    if (attr.name === "__slot") continue;
    if (names.has(attr.name)) return { props: [], supported: false, reason: `<${element}> repeats attribute ${attr.name}; edit it in source.` };
    names.add(attr.name);
    const range = attrRanges[i];
    if (!range) {
      return {
        props: [],
        supported: false,
        reason: `<${element}> has an attribute without source offsets; edit it in source.`,
      };
    }
    const located = locateLiteral(source, range.from, range.to);
    if (!located) {
      return {
        props: [],
        supported: false,
        reason: `<${element} ${attr.name}> is not a plain literal; edit it in source.`,
      };
    }
    const value = attr.value;
    if (typeof value === "string") {
      // Quoted string attribute: value excludes the quotes; the range keeps
      // them, so patches rewrite only this literal.
      props.push({
        name: attr.name,
        kind: "string",
        syntax: located.syntax,
        from: located.from,
        to: located.to,
        expected: located.inner,
        value,
      });
      continue;
    }
    if (value != null && typeof value === "object") {
      const literal = parseExpressionLiteral(located.inner);
      if (!literal) {
        return {
          props: [],
          supported: false,
          reason: `<${element} ${attr.name}> is a computed expression; edit it in source.`,
        };
      }
      props.push({
        name: attr.name,
        kind: literal.kind,
        syntax: located.syntax,
        from: located.from,
        to: located.to,
        expected: located.inner,
        value: literal.value,
      });
      continue;
    }
    return {
      props: [],
      supported: false,
      reason: `<${element} ${attr.name}> has no value literal; edit it in source.`,
    };
  }
  return { props, supported: true };
}

function collectMdx(tree: unknown, source: string, catalog: readonly ComponentDefinition[] = COMPONENT_CATALOG): Instrumentation {
  const elements: Array<MdxJsxElement & SourceRange> = [];
  const texts: Array<{ node: Positioned; range: SourceRange; value: string }> =
    [];
  const codes: TextLeaf[] = [];

  visit(tree as never, (node: unknown) => {
    const typed = node as { type?: string; value?: unknown } & Positioned &
      MdxJsxElement;
    if (
      typed.type === "mdxJsxFlowElement" ||
      typed.type === "mdxJsxTextElement"
    ) {
      const range = offsets(typed);
      if (range && typeof typed.name === "string") {
        elements.push({ ...(typed as MdxJsxElement), ...range });
      }
      return;
    }
    if (typed.type === "text" && typeof typed.value === "string") {
      if (typed.value.trim() === "") return;
      const range = offsets(typed);
      if (range) texts.push({ node: typed, range, value: typed.value });
    }
    if (typed.type === 'code' && typeof typed.value === 'string') {
      const range = offsets(typed);
      if (range) {
        const code = codeRegion(source, range.from, range.to, typed.value, (typed as { lang?: string }).lang ?? '');
        if (code) codes.push({ ...range, expected: source.slice(range.from, range.to), code });
      }
    }
  });

  const components: ComponentSlot[] = elements.map((element, index) => {
    const attrRanges: SourceRange[] = [];
    for (const attr of element.attributes ?? []) {
      const range = offsets(attr as Positioned);
      attrRanges.push(range ?? { from: element.from, to: element.from });
    }
    const definition = catalog.find(entry => entry.name === element.name && entry.editableProps);
    if (!definition) {
      return {
        index,
        element: element.name ?? "unknown",
        from: element.from,
        to: element.to,
        props: [],
        supported: false,
        editableChildren: editableChildNames.has(element.name ?? ''),
        reason: `<${element.name}> is not a source-editable component; edit it in source.`,
      };
    }
    const extracted = extractLiteralProps(
      source,
      element.name ?? "",
      element.attributes ?? [],
      attrRanges,
    );
    return {
      index,
      element: element.name ?? "",
      from: element.from,
      to: element.to,
      props: extracted.props.filter(prop => definition.props.some(p => p.name === prop.name && p.type === prop.kind)),
      supported: extracted.supported,
      editableChildren: editableChildNames.has(element.name ?? ''),
      reason: extracted.reason,
    };
  });

  const insideUnsupported = (range: SourceRange): boolean =>
    components.some(
      (component) =>
        !component.supported && !component.editableChildren &&
        range.from >= component.from &&
        range.to <= component.to,
    );

  const leaves: TextLeaf[] = texts
    .filter(({ range }) => !insideUnsupported(range))
    .map(({ range }) => ({
      from: range.from,
      to: range.to,
      expected: source.slice(range.from, range.to),
      ...(components.some(component => component.editableChildren && range.from >= component.from && range.to <= component.to) ? { literal: true } : {}),
    }));
  for (const component of components.filter(entry => entry.editableChildren)) {
    const insertion = emptyChildInsertion(source, component);
    if (insertion !== undefined && !insideUnsupported({ from: insertion, to: insertion })) {
      leaves.push({ from: insertion, to: insertion, expected: '', literal: true });
    }
  }

  const blockMap = collectBlocks(tree, source);
  return {
    leaves: [
      ...leaves,
      ...codes.filter(region => !insideUnsupported(region)),
      ...blockMap.richLeaves
        .filter((leaf) => leaf.from === leaf.to)
        .map(({ from, to, expected }) => ({ from, to, expected })),
    ],
    components,
    ...blockMap,
  };
}

function capturePlugin(collected: { tree: unknown | null }) {
  return (tree: unknown) => {
    collected.tree = tree;
  };
}

type PositionedTree = {
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: PositionedTree[];
  attributes?: PositionedTree[];
};

/**
 * The parser skips a byte order mark at the start of a file, so its offsets
 * count from the character after it. Every range here is an offset into the
 * source itself, so move them past the mark: a file saved with one is edited
 * in place and keeps it.
 */
function sourceOffsetsPlugin() {
  return (tree: unknown, file: { value: unknown }) => {
    if (!String(file.value).startsWith("﻿")) return;
    const moved = new WeakSet<object>();
    const move = (point: { offset?: number } | undefined) => {
      if (!point || typeof point.offset !== "number" || moved.has(point)) return;
      moved.add(point);
      point.offset += 1;
    };
    const walk = (node: PositionedTree) => {
      move(node.position?.start);
      move(node.position?.end);
      for (const child of node.children ?? []) walk(child);
      for (const attribute of node.attributes ?? []) walk(attribute);
    };
    walk(tree as PositionedTree);
  };
}

// The offsets plugin runs first, before any plugin reads a position.
const SHARED_REMARK_PLUGINS = [sourceOffsetsPlugin, remarkGfm, remarkFrontmatter] as const;

// Only components whose implementations preserve their static children. Chart
// descriptors, resources and unknown JSX never acquire text-edit authority here.
const editableChildNames = new Set([
  'Card', 'CardHeader', 'CardTitle', 'CardDescription', 'CardContent', 'CardFooter',
  'Alert', 'AlertTitle', 'AlertDescription', 'Callout', 'Badge', 'Button', 'Columns',
  'Note', 'Warning', 'Important', 'ExampleCard', 'Instruction', 'Instruction.Action',
  'Instruction.Implementation', 'SideBySide', 'SideBySide.Block', 'SideBySideBlock', 'Tabs', 'Tab',
  'div', 'span', 'p', 'section', 'article', 'aside', 'header', 'footer',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'b', 'i', 'u', 's', 'a',
  'ul', 'ol', 'li', 'blockquote', 'details', 'summary', 'figcaption', 'figure',
  'table', 'thead', 'tbody', 'tr', 'td', 'th',
]);

function emptyChildInsertion(source: string, component: SourceRange): number | undefined {
  const raw = source.slice(component.from, component.to);
  const close = /<\/[\w.:-]+\s*>$/.exec(raw);
  if (!close) return undefined;
  // A conservative first delimiter avoids mistaking a nested child's closing
  // tag for this element's opener. An attribute containing `>` simply does not
  // get an empty-child insertion target (nonempty children still work).
  const openingEnd = raw.indexOf('>');
  return openingEnd >= 0 && /^\s*$/.test(raw.slice(openingEnd + 1, close.index))
    ? component.from + close.index
    : undefined;
}

/**
 * Instrument an MDX document: editable prose leaves plus Counter/Callout
 * literal-prop slots, all with byte offsets into `source`. Throws a
 * descriptive compile error for invalid MDX; the caller keeps the source
 * recoverable and shows the message.
 */
export async function instrumentMdxSource(
  source: string,
  catalog: readonly ComponentDefinition[] = COMPONENT_CATALOG,
): Promise<Instrumentation> {
  const collected: { tree: unknown | null } = { tree: null };
  try {
    await compile(source, {
      outputFormat: "function-body",
      remarkPlugins: [
        ...SHARED_REMARK_PLUGINS,
        [capturePlugin, collected] as never,
      ],
    });
  } catch (error) {
    throw new Error(
      `Invalid MDX: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!collected.tree)
    throw new Error("Invalid MDX: the parser produced no document.");
  return collectMdx(collected.tree, source, catalog);
}

/**
 * Instrument a plain `.md` document through the same official compiler in
 * `md` format: markdown stays literal markdown (no JSX recognition, braces
 * never evaluate as expressions) and no JavaScript is ever evaluated for
 * this format. Leaves carry the same exact source slices as MDX.
 */
export async function instrumentMarkdownSource(
  source: string,
): Promise<Instrumentation> {
  const collected: { tree: unknown | null } = { tree: null };
  try {
    await compile(source, {
      outputFormat: "function-body",
      format: "md",
      remarkPlugins: [
        ...SHARED_REMARK_PLUGINS,
        [capturePlugin, collected] as never,
      ],
    });
  } catch (error) {
    throw new Error(
      `Invalid Markdown: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!collected.tree)
    throw new Error("Invalid Markdown: the parser produced no document.");
  return collectMdx(collected.tree, source);
}

const expressionLiteral = (raw: string): Record<string, unknown> => ({
  type: "mdxJsxExpressionAttribute",
  value: raw,
  data: {
    estree: {
      type: "Program",
      body: [
        {
          type: "ExpressionStatement",
          expression: { type: "Literal", value: Number(raw), raw },
        },
      ],
      sourceType: "module",
    },
  },
});

function markPlugin(
  source: string,
  slots: ComponentSlot[],
  authoring: boolean,
) {
  const unsupportedRanges = slots
    .filter((slot) => !slot.supported && !slot.editableChildren)
    .map((slot) => ({ from: slot.from, to: slot.to }));
  return () => (tree: unknown) => {
    const map = collectBlocks(tree, source);
    const blocks = authoring ? map.blocks : [];
    const blockNode = (block: (typeof blocks)[number]) => ({
      type: "mdxJsxTextElement",
      name: "SourceBlock",
      attributes: [
        { type: "mdxJsxAttribute", name: "blockId", value: block.id },
        { type: "mdxJsxAttribute", name: "value", value: block.value },
        {
          type: "mdxJsxAttribute",
          name: "from",
          value: expressionLiteral(String(block.contentFrom)),
        },
      ],
      children: [],
    });
    visit(tree as never, (node: unknown) => {
      const typed = node as {
        type: string;
        position?: { start: { offset?: number } };
        children?: unknown[];
      };
      const offset = typed.position?.start.offset;
      const block = blocks.find(
        (entry) =>
          entry.kind !== "gap" &&
          (entry.from === offset || entry.contentFrom === offset),
      );
      if (!block) return;
      if (typed.type === "paragraph" || typed.type === "heading")
        typed.children = [blockNode(block)];
      if (typed.type === "listItem" && !typed.children?.length)
        typed.children = [{ type: "paragraph", children: [blockNode(block)] }];
      if (typed.type === "blockquote" && !typed.children?.length)
        typed.children = [{ type: "paragraph", children: [blockNode(block)] }];
    });
    const root = tree as {
      children: Array<{ position?: { start: { offset?: number } } }>;
    };
    if (authoring)
      for (const leaf of map.richLeaves.filter(
        (entry) => entry.from === entry.to,
      )) {
        const node = root.children.find(
          (entry) => entry.position?.start.offset === leaf.blockFrom,
        ) as { children?: unknown[] } | undefined;
        node?.children?.push({
          type: "mdxJsxTextElement",
          name: "SourceText",
          attributes: [
            {
              type: "mdxJsxAttribute",
              name: "from",
              value: expressionLiteral(String(leaf.from)),
            },
            {
              type: "mdxJsxAttribute",
              name: "to",
              value: expressionLiteral(String(leaf.to)),
            },
            { type: "mdxJsxAttribute", name: "expected", value: "" },
          ],
          children: [],
        });
      }
    for (const block of blocks.filter((entry) => entry.kind === "gap")) {
      const index = root.children.findIndex(
        (node) => (node.position?.start.offset ?? Infinity) > block.from,
      );
      root.children.splice(index < 0 ? root.children.length : index, 0, {
        type: "paragraph",
        children: [blockNode(block)],
      } as never);
    }
    let slotCursor = 0;
    const slotByRange = new Map<string, number>();
    for (const slot of slots)
      slotByRange.set(`${slot.from}:${slot.to}`, slot.index);
    const insideUnsupported = (from: number, to: number): boolean =>
      unsupportedRanges.some((range) => from >= range.from && to <= range.to);
    // Ranges already wrapped: `visit` descends into the replacement children,
    // so without this the new child text node would wrap itself forever.
    const wrapped = new Set<string>();
    visit(tree as never, (node: unknown) => {
      const typed = node as Record<string, unknown>;
      if (typed.type === 'code') {
        const range = offsets(typed as Positioned);
        if (!range || insideUnsupported(range.from, range.to)) return;
        const code = codeRegion(source, range.from, range.to, String(typed.value ?? ''), String(typed.lang ?? ''));
        if (!code) return;
        typed.type = 'mdxJsxFlowElement';
        typed.name = 'SourceCode';
        typed.attributes = [
          { type: 'mdxJsxAttribute', name: 'from', value: expressionLiteral(String(range.from)) },
          { type: 'mdxJsxAttribute', name: 'to', value: expressionLiteral(String(range.to)) },
          { type: 'mdxJsxAttribute', name: 'expected', value: source.slice(range.from, range.to) },
          { type: 'mdxJsxAttribute', name: 'value', value: code.value },
          { type: 'mdxJsxAttribute', name: 'language', value: code.language },
        ];
        typed.children = [];
        return;
      }
      if (typed["type"] === "text") {
        const value = typed["value"];
        if (typeof value !== "string" || value.trim() === "") return;
        const position = typed["position"] as
          { start: { offset?: number }; end: { offset?: number } } | undefined;
        const from = position?.start.offset;
        const to = position?.end.offset;
        if (
          typeof from !== "number" ||
          typeof to !== "number" ||
          wrapped.has(`${from}:${to}`) ||
          insideUnsupported(from, to)
        ) {
          return;
        }
        wrapped.add(`${from}:${to}`);
        // Wrap the leaf so the child can report source-range patches
        // without ever seeing the source. `expected` carries the exact
        // source slice (entities/escapes intact); the child element holds
        // the decoded text. The parent matches `expected` against its own
        // instrumentation before applying any patch.
        typed["type"] = "mdxJsxTextElement";
        typed["name"] = "SourceText";
        typed["attributes"] = [
          {
            type: "mdxJsxAttribute",
            name: "from",
            value: expressionLiteral(String(from)),
          },
          {
            type: "mdxJsxAttribute",
            name: "to",
            value: expressionLiteral(String(to)),
          },
          {
            type: "mdxJsxAttribute",
            name: "expected",
            value: source.slice(from, to),
          },
        ];
        if (slots.some(slot => slot.editableChildren && from >= slot.from && to <= slot.to)) {
          (typed.attributes as unknown[]).push({ type: 'mdxJsxAttribute', name: 'literal', value: null });
        }
        typed["children"] = [
          { type: "text", value, position: typed["position"] },
        ];
        return;
      }
      if (
        (typed["type"] === "mdxJsxFlowElement" ||
          typed["type"] === "mdxJsxTextElement") &&
        typed["name"] !== "SourceText" &&
        typed["name"] !== "SourceCode" &&
        typed["name"] !== "SourceBlock"
      ) {
        const position = typed["position"] as
          { start: { offset?: number }; end: { offset?: number } } | undefined;
        const from = position?.start.offset;
        const to = position?.end.offset;
        const index =
          typeof from === "number" && typeof to === "number"
            ? (slotByRange.get(`${from}:${to}`) ?? slotCursor)
            : slotCursor;
        const slot = slots.find(entry => entry.index === index);
        const insertion = slot?.editableChildren && !insideUnsupported(slot.from, slot.to)
          ? emptyChildInsertion(source, slot)
          : undefined;
        if (insertion !== undefined) {
          typed.children = [{ type: 'mdxJsxTextElement', name: 'SourceText', attributes: [
            { type: 'mdxJsxAttribute', name: 'from', value: expressionLiteral(String(insertion)) },
            { type: 'mdxJsxAttribute', name: 'to', value: expressionLiteral(String(insertion)) },
            { type: 'mdxJsxAttribute', name: 'expected', value: '' },
            { type: 'mdxJsxAttribute', name: 'literal', value: null },
          ], children: [] }];
        }
        slotCursor += 1;
        const attributes = typed["attributes"] as
          Array<Record<string, unknown>> | undefined;
        attributes?.push({
          type: "mdxJsxAttribute",
          name: "__slot",
          value: {
            type: "mdxJsxExpressionAttribute",
            value: String(index),
            data: {
              estree: {
                type: "Program",
                body: [
                  {
                    type: "ExpressionStatement",
                    expression: {
                      type: "Literal",
                      value: index,
                      raw: String(index),
                    },
                  },
                ],
                sourceType: "module",
              },
            },
          },
        });
      }
    });
    return undefined;
  };
}

/**
 * Compile a document for the sandboxed preview. Parser and compiler run in
 * the parent; the emitted code is only ever evaluated inside the opaque-origin
 * child frame. Editable text leaves are wrapped in `<SourceText>` markers
 * (with exact-slice `expected` props) and supported components get a stable
 * `__slot` index so the child can report source-range patches without seeing
 * the source. `format` selects the MDX or plain-Markdown pipeline; remark-gfm
 * and frontmatter apply to both.
 */
export async function compileForPreview(
  source: string,
  slots: ComponentSlot[],
  format: DocumentFormat = "mdx",
  authoring = false,
  projectAst?: {
    before: (tree: unknown) => void;
    after: (tree: unknown) => void;
  },
  catalog: readonly ComponentDefinition[] = COMPONENT_CATALOG,
): Promise<string> {
  const file = await compile(source, {
    outputFormat: "function-body",
    format,
    remarkPlugins: [
      ...SHARED_REMARK_PLUGINS,
      ...(projectAst ? [(() => projectAst.before) as never] : []),
      markPlugin(source, slots, authoring) as never,
      (() => (tree: unknown) => {
        const custom = new Set(catalog.filter(c => c.editableProps && !COMPONENT_CATALOG.some(b => b.name === c.name)).map(c => c.name));
        const wrapped = new WeakSet<object>();
        visit(tree as never, (value: unknown) => {
          const n = value as Record<string, unknown>;
          if (wrapped.has(n) || !custom.has(String(n.name))) return;
          const child = {...n};
          wrapped.add(child);
          const attributes = n.attributes as Array<{name?: string}>;
          n.name = 'CustomControls';
          n.attributes = attributes.filter(a => a.name === '__slot');
          if (n.type === 'mdxJsxTextElement') (n.attributes as unknown[]).push({type:'mdxJsxAttribute',name:'inline',value:null});
          n.children = [child];
        });
      }) as never,
      ...(projectAst ? [(() => projectAst.after) as never] : []),
      workspaceImportPlugin,
    ],
  });
  return String(file.value);
}
