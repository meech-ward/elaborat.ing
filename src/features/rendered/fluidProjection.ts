import {
  applySourcePatches,
  encodeProseText,
  type DocumentFormat,
  type DocumentSnapshot,
  type SourcePatch,
} from "../document";
import { Fragment, Mark, type Node as PMNode } from "prosemirror-model";
import {
  Step,
  ReplaceStep,
  AddMarkStep,
  RemoveMarkStep,
} from "prosemirror-transform";
import { decodeString } from "micromark-util-decode-string";
import { z } from "zod";
import type { FluidSyntaxHint } from "./protocol";
import {
  compileForPreview,
  instrumentMdxSource,
  instrumentMarkdownSource,
  type ComponentSlot,
  type Instrumentation,
} from "./instrumentation";
import { fluidSchema } from "./fluidSchema";
import { prepareComponentEnvironment, type ComponentEnvironment } from '../document/componentModules';
import { COMPONENT_CATALOG } from '../document/componentCatalog';
export interface FluidIsland {
  id: string;
  from: number;
  to: number;
  inline: boolean;
}
type Ast = {
  type: string;
  value?: string;
  depth?: number;
  ordered?: boolean;
  start?: number;
  url?: string;
  title?: string | null;
  children?: Ast[];
  position?: { start: { offset?: number }; end: { offset?: number } };
};
type Frame = {
  mark: Mark;
  from: number;
  to: number;
  pos: number;
  end: number;
  open: string;
  close: string;
};
type MappedNode = {
  node: PMNode;
  ast: Ast;
  from: number;
  to: number;
  pos: number;
  end: number;
  root: number;
};
type Leaf = {
  from: number;
  to: number;
  pos: number;
  end: number;
  value: string;
  boundaries: Array<number | null>;
  frames: Frame[];
  root: number;
};
export interface FluidProjection {
  components: ComponentEnvironment;
  text: string;
  format: DocumentFormat;
  doc: PMNode;
  code: string;
  slots: ComponentSlot[];
  islands: FluidIsland[];
  instrumentation: Instrumentation;
  runtimeKey: string;
  /** Parent-owned mapping; never accept this object from the child. */
  mapping: { leaves: Leaf[]; nodes: MappedNode[]; roots: MappedNode[] };
}

const range = (node: Ast) => {
  const from = node.position?.start.offset,
    to = node.position?.end.offset;
  if (from == null || to == null)
    throw new Error("Projection node has no authoritative source range");
  return { from, to };
};
function islandHash(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++)
    hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(36);
}

/** Decoded UTF-16 boundaries point only to complete source tokens. */
function decodedBoundaries(
  raw: string,
  value: string,
  from: number,
  code: boolean,
): Array<number | null> {
  const result: Array<number | null> = Array(value.length + 1).fill(null);
  let input = 0,
    output = 0;
  result[0] = from;
  while (input < raw.length) {
    const remaining = raw.slice(input);
    let token = remaining.startsWith("\r\n")
      ? "\r\n"
      : String.fromCodePoint(raw.codePointAt(input)!);
    if (!code)
      token =
        /^(?:\\[!-/:-@\[-`{-~]|&(?:#[xX][\da-fA-F]+|#\d+|[A-Za-z][A-Za-z\d]+);)/.exec(
          remaining,
        )?.[0] ?? token;
    const decoded = code
      ? token.replace(/\r\n?|\n/g, " ")
      : decodeString(token).replace(/\r\n?/g, "\n");
    if (
      !value.startsWith(decoded, output) &&
      output > 0 &&
      value[output - 1] === "\n"
    ) {
      // Markdown container prefixes are absent from the parser's text value.
      const prefix = /^(?:[ \t]*>[ \t]?)+|^[ \t]+/.exec(remaining)?.[0];
      if (prefix) {
        input += prefix.length;
        result[output] = from + input;
        continue;
      }
    }
    if (!value.startsWith(decoded, output))
      throw new Error("Cannot map decoded source text exactly");
    result[output] = from + input;
    input += token.length;
    output += decoded.length;
    result[output] = from + input;
  }
  if (output !== value.length)
    throw new Error("Decoded source length differs from its parser value");
  return result;
}

export async function projectFluidSource(
  text: string,
  format: DocumentFormat,
  environment?: ComponentEnvironment,
): Promise<FluidProjection> {
  const components = environment ?? (format === 'mdx' ? await prepareComponentEnvironment(text) : {source:text,catalog:COMPONENT_CATALOG,modules:[],key:'',code:[]});
  const instrumentation = await (format === "mdx"
    ? instrumentMdxSource(text, components.catalog)
    : instrumentMarkdownSource(text));
  const slots = instrumentation.components;
  const leaves: Leaf[] = [],
    nodes: MappedNode[] = [],
    roots: MappedNode[] = [],
    islands: FluidIsland[] = [];
  const islandAsts: Ast[] = [],
    retained: Ast[] = [];
  const occurrences = new Map<string, number>();
  let doc: PMNode = fluidSchema.node("doc", null, [
    fluidSchema.node("paragraph"),
  ]);
  const island = (
    ast: Ast,
    inline: boolean,
    pos: number,
    root: number,
    marks: readonly Mark[] = [],
  ): PMNode => {
    const { from, to } = range(ast),
      hash = islandHash(text.slice(from, to));
    const count = occurrences.get(hash) ?? 0;
    occurrences.set(hash, count + 1);
    const id = `island:${hash}:${count}`;
    islands.push({ id, from, to, inline });
    islandAsts.push(ast);
    const node = fluidSchema.node(
      inline ? "inline_object" : "object",
      { id },
      undefined,
      marks,
    );
    nodes.push({ node, ast, from, to, pos, end: pos + node.nodeSize, root });
    return node;
  };
  const inline = (
    ast: Ast,
    pos: number,
    root: number,
    frames: Frame[] = [],
  ): PMNode[] => {
    const { from, to } = range(ast);
    if (ast.type === "text" || ast.type === "inlineCode") {
      const value = ast.value ?? "";
      let innerFrom = from,
        innerTo = to,
        active = frames;
      if (ast.type === "inlineCode") {
        const ticks = /^`+/.exec(text.slice(from, to))?.[0];
        if (!ticks) throw new Error("Code span missing source delimiter");
        innerFrom += ticks.length;
        innerTo -= ticks.length;
        const normalized = text
          .slice(innerFrom, innerTo)
          .replace(/\r\n?|\n/g, " ");
        if (
          normalized.startsWith(" ") &&
          normalized.endsWith(" ") &&
          /[^ ]/.test(normalized)
        ) {
          innerFrom++;
          innerTo--;
        }
        active = [
          {
            mark: fluidSchema.marks.code.create(),
            from,
            to,
            pos,
            end: pos + value.length,
            open: text.slice(from, innerFrom),
            close: text.slice(innerTo, to),
          },
        ];
      }
      leaves.push({
        from: innerFrom,
        to: innerTo,
        pos,
        end: pos + value.length,
        value,
        boundaries: decodedBoundaries(
          text.slice(innerFrom, innerTo),
          value,
          innerFrom,
          ast.type === "inlineCode",
        ),
        frames: active,
        root,
      });
      return value
        ? [
            fluidSchema.text(
              value,
              Mark.setFrom(active.map((frame) => frame.mark)),
            ),
          ]
        : [];
    }
    if (ast.type === "break") return [fluidSchema.node("hard_break")];
    const markName = (
      {
        strong: "strong",
        emphasis: "em",
        delete: "strike",
        link: "link",
      } as Record<string, string>
    )[ast.type];
    if (markName && ast.children?.length) {
      const frame: Frame = {
        mark: fluidSchema.marks[markName].create(
          ast.type === "link"
            ? { href: ast.url, title: ast.title ?? null }
            : null,
        ),
        from,
        to,
        pos,
        end: pos,
        open: text.slice(from, range(ast.children[0]).from),
        close: text.slice(range(ast.children.at(-1)!).to, to),
      };
      const result: PMNode[] = [];
      for (const child of ast.children) {
        const parts = inline(child, pos, root, [...frames, frame]);
        result.push(...parts);
        pos += parts.reduce((sum, node) => sum + node.nodeSize, 0);
      }
      frame.end = pos;
      return result;
    }
    return [
      island(
        ast,
        true,
        pos,
        root,
        Mark.setFrom(frames.map((frame) => frame.mark)),
      ),
    ];
  };
  const isContainer = (ast: Ast): boolean =>
    ["list", "listItem", "blockquote"].includes(ast.type);
  const isPlainBlock = (ast: Ast): boolean =>
    ["paragraph", "heading", "thematicBreak"].includes(ast.type);
  const block = (ast: Ast, pos: number, root: number): PMNode => {
    const { from, to } = range(ast);
    let node: PMNode;
    if (ast.type === "paragraph" || ast.type === "heading") {
      const content: PMNode[] = [];
      let at = pos + 1;
      for (const child of ast.children ?? []) {
        const parts = inline(child, at, root);
        content.push(...parts);
        at += parts.reduce((sum, item) => sum + item.nodeSize, 0);
      }
      // CommonMark omits final horizontal whitespace from text children even
      // though it belongs to the paragraph's source range. Keep that editable
      // source text so an ordinary space keystroke remains representable.
      const lastChild = ast.children?.at(-1);
      const trailingFrom = lastChild ? range(lastChild).to : to;
      const trailing = text.slice(trailingFrom, to);
      if (/^[ \t]+$/.test(trailing)) {
        content.push(
          ...inline(
            {
              type: "text",
              value: trailing,
              position: {
                start: { offset: trailingFrom },
                end: { offset: to },
              },
            },
            at,
            root,
          ),
        );
      }
      node = fluidSchema.node(
        ast.type === "heading" ? "heading" : "paragraph",
        ast.type === "heading" ? { level: ast.depth } : null,
        content,
      );
      if (!content.length) {
        const prefix =
          ast.type === "heading"
            ? (/^#{1,6}[ \t]*/.exec(text.slice(from, to))?.[0].length ?? 0)
            : 0;
        leaves.push({
          from: from + prefix,
          to: from + prefix,
          pos: pos + 1,
          end: pos + 1,
          value: "",
          boundaries: [from + prefix],
          frames: [],
          root,
        });
      }
    } else if (ast.type === "thematicBreak")
      node = fluidSchema.node("horizontal_rule");
    else if (isContainer(ast)) {
      // Mixed containers keep ordinary prose in the one ProseMirror host so
      // native selection stays continuous. Only genuinely complex children
      // (fences, tables, components) become islands inside the container; an
      // unrelated sibling code block no longer ejects the prose around it.
      // Any schema-invalid shape falls back to one island for the container.
      const snapshot = {
        leaves: leaves.length,
        nodes: nodes.length,
        islands: islands.length,
        islandAsts: islandAsts.length,
        occurrences: new Map(occurrences),
      };
      const rollback = () => {
        leaves.length = snapshot.leaves;
        nodes.length = snapshot.nodes;
        islands.length = snapshot.islands;
        islandAsts.length = snapshot.islandAsts;
        occurrences.clear();
        for (const [key, value] of snapshot.occurrences)
          occurrences.set(key, value);
      };
      const name =
        ast.type === "list"
          ? ast.ordered
            ? "ordered_list"
            : "bullet_list"
          : ast.type === "listItem"
            ? "list_item"
            : "blockquote";
      const content: PMNode[] = [];
      let at = pos + 1;
      for (const child of ast.children ?? []) {
        const next =
          isPlainBlock(child) || isContainer(child)
            ? block(child, at, root)
            : island(child, false, at, root);
        content.push(next);
        at += next.nodeSize;
      }
      if (!content.length) {
        const prefix =
          /^(?:[-+*]|\d+[.)]|>)\s*/.exec(text.slice(from, to))?.[0].length ?? 0;
        const empty: Ast = {
          type: "paragraph",
          children: [],
          position: {
            start: { offset: from + prefix },
            end: { offset: from + prefix },
          },
        };
        content.push(block(empty, at, root));
      }
      // A list item opens with its paragraph; a list holds only items. Any
      // other shape (code-first item, prose directly under a list) keeps the
      // previous whole-container island instead of violating the schema.
      const shapeValid =
        (ast.type === "list" &&
          content.every((entry) => entry.type.name === "list_item")) ||
        (ast.type === "listItem" &&
          content[0]?.type.name === "paragraph") ||
        ast.type === "blockquote";
      let built: PMNode | undefined;
      if (shapeValid) {
        try {
          built = fluidSchema.node(
            name,
            ast.type === "list" && ast.ordered
              ? { order: ast.start ?? 1 }
              : null,
            content,
          );
        } catch {
          built = undefined;
        }
      }
      if (!built) {
        rollback();
        return island(ast, false, pos, root);
      }
      node = built;
    } else return island(ast, false, pos, root);
    nodes.push({ node, ast, from, to, pos, end: pos + node.nodeSize, root });
    return node;
  };
  const code = await compileForPreview(text, slots, format, false, {
    before(tree) {
      const content: PMNode[] = [];
      let pos = 0;
      const sourceChildren = (tree as Ast).children ?? [];
      const gapOffsets = instrumentation.blocks
        .filter((entry) => entry.kind === "gap")
        .map((entry) => entry.from);
      const lastSource = sourceChildren.at(-1);
      if (lastSource) {
        const tailFrom = range(lastSource).to;
        const tail = text.slice(tailFrom);
        // A four-newline terminal gap becomes an inter-block blank paragraph
        // plus the typed terminal paragraph. Project both before typing, too.
        if (/^\s*$/.test(tail) && (tail.match(/\n/g)?.length ?? 0) >= 4)
          gapOffsets.push(tailFrom + 2);
      }
      const entries = [
        ...sourceChildren,
        ...[...new Set(gapOffsets)].map(
          (offset) =>
            ({
              type: "paragraph",
              children: [],
              position: {
                start: { offset },
                end: { offset },
              },
            }) as Ast,
        ),
      ].sort((a, b) => range(a).from - range(b).from);
      for (const ast of entries) {
        if (
          ["mdxjsEsm", "yaml", "toml", "definition"].includes(ast.type) ||
          (ast.type === "mdxFlowExpression" && /^\s*\/\*/.test(ast.value ?? ""))
        ) {
          retained.push(ast);
          continue;
        }
        const root = roots.length,
          node = block(ast, pos, root);
        const mapped = [...nodes]
          .reverse()
          .find((entry) => entry.node === node)!;
        roots.push(mapped);
        content.push(node);
        pos += node.nodeSize;
      }
      if (
        !content.length ||
        (/(?:\r?\n){2}[ \t]*$/.test(text) && roots.at(-1)?.from !== text.length)
      ) {
        const offset = text.length;
        const ast: Ast = {
          type: "paragraph",
          children: [],
          position: { start: { offset }, end: { offset } },
        };
        const node = block(ast, pos, roots.length);
        roots.push(nodes.at(-1)!);
        content.push(node);
      }
      doc = fluidSchema.node("doc", null, content);
    },
    after(tree) {
      // The original AST references have now received ordinary slot/prose
      // instrumentation. Compile only islands, retaining the document ESM scope.
      (tree as Ast).children = [
        ...retained,
        ...islandAsts.map(
          (ast, index) =>
            ({
              type: "mdxJsxFlowElement",
              name: "FluidIsland",
              attributes: [
                {
                  type: "mdxJsxAttribute",
                  name: "id",
                  value: islands[index].id,
                },
              ],
              children: [ast],
            }) as Ast,
        ),
      ];
    },
  }, components.catalog);
  const runtimeKey = islandHash(
    JSON.stringify({
      format,
      modules: components.key,
      retained: retained.map((ast) => {
        const { from, to } = range(ast);
        return text.slice(from, to);
      }),
      islands: islands.map((entry) => ({
        id: entry.id,
        source: text.slice(entry.from, entry.to),
      })),
    }),
  );
  return {
    components,
    text,
    format,
    doc,
    code,
    slots,
    islands,
    instrumentation,
    runtimeKey,
    mapping: { leaves, nodes, roots },
  };
}

function leafAt(
  projection: FluidProjection,
  position: number,
  assoc: -1 | 1,
): Leaf | undefined {
  const candidates = projection.mapping.leaves.filter(
    (leaf) => position >= leaf.pos && position <= leaf.end,
  );
  return assoc === 1 ? candidates.at(-1) : candidates[0];
}
export function fluidSourceOffsetForPosition(
  projection: FluidProjection,
  position: number,
  assoc: -1 | 1 = 1,
): number | null {
  const leaf = leafAt(projection, position, assoc);
  return leaf?.boundaries[position - leaf.pos] ?? null;
}
export function fluidPositionForSourceOffset(
  projection: FluidProjection,
  offset: number,
): number | null {
  let nearest: { distance: number; position: number } | undefined;
  for (const leaf of projection.mapping.leaves) {
    for (let i = 0; i < leaf.boundaries.length; i++) {
      const boundary = leaf.boundaries[i];
      if (boundary == null) continue;
      const distance = Math.abs(boundary - offset);
      if (!nearest || distance < nearest.distance)
        nearest = { distance, position: leaf.pos + i };
    }
  }
  return nearest?.position ?? null;
}

function canonicalFrame(
  mark: Mark,
  hint?: FluidSyntaxHint,
): Pick<Frame, "mark" | "open" | "close"> {
  const delimiter = hint && "delimiter" in hint ? hint.delimiter : undefined;
  const syntax = (
    {
      strong: delimiter === "__" ? ["__", "__"] : ["**", "**"],
      em: delimiter === "_" ? ["_", "_"] : ["*", "*"],
      strike: ["~~", "~~"],
      code: ["`", "`"],
    } as Record<string, string[]>
  )[mark.type.name];
  if (syntax) return { mark, open: syntax[0], close: syntax[1] };
  if (mark.type.name === "link") {
    const href = String(mark.attrs.href).replace(/[\\<>\r\n]/g, (char) =>
      encodeURIComponent(char),
    );
    const title =
      mark.attrs.title == null
        ? ""
        : ` "${String(mark.attrs.title).replace(/[\\"]/g, "\\$&")}"`;
    return { mark, open: "[", close: `](<${href}>${title})` };
  }
  throw new Error("Unsupported inline mark");
}
type SyntaxFrame = Pick<Frame, "mark" | "open" | "close">;
function inlineSource(
  content: Fragment,
  format: DocumentFormat,
  start: SyntaxFrame[] = [],
  end: SyntaxFrame[] = [],
  preserve?: FluidProjection,
  hint?: FluidSyntaxHint,
): string {
  let active = start,
    output = "";
  const transition = (next: SyntaxFrame[]) => {
    let shared = 0;
    while (
      shared < active.length &&
      shared < next.length &&
      active[shared].mark.eq(next[shared].mark)
    )
      shared++;
    for (let i = active.length - 1; i >= shared; i--) output += active[i].close;
    for (let i = shared; i < next.length; i++) output += next[i].open;
    active = [...active.slice(0, shared), ...next.slice(shared)];
  };
  content.forEach((node) => {
    if (node.type.name === "hard_break") {
      transition([]);
      output += "\\\n";
      return;
    }
    if (!node.isText)
      throw new Error("Inline mutation touches a protected object");
    const original = preserve?.mapping.leaves.find(
      (leaf) =>
        leaf.value === node.text &&
        Mark.sameSet(
          Mark.setFrom(leaf.frames.map((frame) => frame.mark)),
          node.marks,
        ),
    );
    const frames =
      original?.frames ??
      node.marks.map((mark) => {
        const known = [...active, ...start, ...end].find((frame) =>
          frame.mark.eq(mark),
        );
        if (known) return known;
        if (mark.type.name === "code") {
          const ticks = "`".repeat(
            Math.max(
              0,
              ...Array.from(
                node.text!.matchAll(/`+/g),
                (match) => match[0].length,
              ),
            ) + 1,
          );
          const padding =
            /^`|`$/.test(node.text!) ||
            (/^ .* $/.test(node.text!) && /[^ ]/.test(node.text!))
              ? " "
              : "";
          return { mark, open: ticks + padding, close: padding + ticks };
        }
        return canonicalFrame(mark, hint);
      });
    transition(frames);
    let encoded = node.marks.some((mark) => mark.type.name === "code")
      ? node.text!
      : encodeProseText(node.text!, format);
    if (
      preserve &&
      node.marks.length &&
      !node.marks.some((mark) => mark.type.name === "code")
    ) {
      // Markdown delimiter edges cannot contain literal whitespace. Numeric
      // references retain the exact projected characters and marks instead of
      // dropping a typed space or silently removing its formatting.
      encoded = encoded.replace(/^\s+|\s+$/g, (spaces) =>
        Array.from(spaces, (char) => `&#${char.codePointAt(0)};`).join(""),
      );
    }
    output += original
      ? preserve!.text.slice(original.from, original.to)
      : encoded;
  });
  transition(end);
  return output;
}
function endpoint(
  projection: FluidProjection,
  position: number,
  side: "start" | "end",
  expand: boolean,
) {
  const leaf = leafAt(projection, position, side === "start" ? 1 : -1);
  if (!leaf) throw new Error("Unsupported structural endpoint");
  let raw = leaf.boundaries[position - leaf.pos];
  if (raw == null) throw new Error("Cannot split an encoded source character");
  let frames = leaf.frames;
  if (expand) {
    const removed = frames.filter((frame) =>
      side === "start" ? position === frame.pos : position === frame.end,
    );
    if (removed.length) {
      raw =
        side === "start"
          ? Math.min(raw, ...removed.map((frame) => frame.from))
          : Math.max(raw, ...removed.map((frame) => frame.to));
      frames = frames.filter((frame) => !removed.includes(frame));
    }
  }
  return { raw, frames, leaf };
}
function assertUnprotected(
  projection: FluidProjection,
  from: number,
  to: number,
) {
  for (const entry of projection.mapping.nodes) {
    if (
      ["object", "inline_object"].includes(entry.node.type.name) &&
      from < entry.end &&
      to > entry.pos
    )
      throw new Error("Selection crosses a protected object");
  }
  const crossed = projection.mapping.roots.filter(
    (root) => from < root.end && to > root.pos,
  );
  for (let i = 1; i < crossed.length; i++) {
    if (
      !/^\s*$/.test(projection.text.slice(crossed[i - 1].to, crossed[i].from))
    )
      throw new Error("Selection crosses protected unrendered source");
  }
}
function inlinePatch(
  projection: FluidProjection,
  from: number,
  to: number,
  content: Fragment,
  split = false,
  hint?: FluidSyntaxHint,
): SourcePatch {
  assertUnprotected(projection, from, to);
  const start = endpoint(projection, from, "start", from !== to);
  const end = from === to ? start : endpoint(projection, to, "end", true);
  let insert: string;
  if (split)
    insert =
      start.frames
        .slice()
        .reverse()
        .map((frame) => frame.close)
        .join("") +
      "\n\n" +
      start.frames.map((frame) => frame.open).join("");
  else
    insert = inlineSource(
      content,
      projection.format,
      start.frames,
      end.frames,
      undefined,
      hint,
    );
  const emptyRoot = projection.mapping.roots.find(
    (root) => root.pos + 1 === from && root.from === root.to,
  );
  if (
    emptyRoot &&
    start.raw > 0 &&
    !/(?:\r?\n){2}[ \t]*$/.test(projection.text.slice(0, start.raw))
  )
    insert = "\n\n" + insert;
  return {
    from: start.raw,
    to: end.raw,
    insert,
    expected: projection.text.slice(start.raw, end.raw),
  };
}

/** Serialize only a changed, parser-owned ordinary subtree. Exact unchanged
 * sibling subtrees are reused; this never serializes the document. */
function blockSource(
  node: PMNode,
  projection: FluidProjection,
  reuse = true,
  hint?: FluidSyntaxHint,
  originalMarker = "-",
): string {
  const old = reuse
    ? projection.mapping.nodes.find((entry) => entry.node.eq(node))
    : undefined;
  if (old) return projection.text.slice(old.from, old.to);
  switch (node.type.name) {
    case "paragraph":
      return inlineSource(
        node.content,
        projection.format,
        [],
        [],
        projection,
        hint,
      );
    case "heading":
      return (
        "#".repeat(node.attrs.level) +
        " " +
        inlineSource(node.content, projection.format, [], [], projection, hint)
      );
    case "horizontal_rule":
      return "---";
    case "blockquote": {
      const parts: string[] = [];
      node.forEach((child) => {
        parts.push(blockSource(child, projection, true, hint, originalMarker));
      });
      return parts
        .join("\n\n")
        .split("\n")
        .map((line) => "> " + line)
        .join("\n");
    }
    case "bullet_list":
    case "ordered_list": {
      const parts: string[] = [];
      node.forEach((item, _, index) => {
        const unchanged = projection.mapping.nodes.find((entry) =>
          entry.node.eq(item),
        );
        if (unchanged) {
          parts.push(projection.text.slice(unchanged.from, unchanged.to));
          return;
        }
        const marker =
          node.type.name === "ordered_list"
            ? `${node.attrs.order + index}. `
            : `${hint && "marker" in hint ? hint.marker : originalMarker} `;
        const body: string[] = [];
        item.forEach((child) => {
          body.push(blockSource(child, projection, true, hint, originalMarker));
        });
        parts.push(
          body
            .join("\n\n")
            .split("\n")
            .map(
              (line, i) =>
                (i === 0 ? marker : " ".repeat(marker.length)) + line,
            )
            .join("\n"),
        );
      });
      return parts.join("\n");
    }
    default:
      throw new Error("Unsupported structural serialization");
  }
}
function structuralPatch(
  projection: FluidProjection,
  next: PMNode,
  hint?: FluidSyntaxHint,
): SourcePatch {
  let prefix = 0;
  while (
    prefix < projection.doc.childCount &&
    prefix < next.childCount &&
    projection.doc.child(prefix).eq(next.child(prefix))
  )
    prefix++;
  let oldEnd = projection.doc.childCount,
    newEnd = next.childCount;
  while (
    oldEnd > prefix &&
    newEnd > prefix &&
    projection.doc.child(oldEnd - 1).eq(next.child(newEnd - 1))
  ) {
    oldEnd--;
    newEnd--;
  }
  let affected = projection.mapping.roots.slice(prefix, oldEnd);
  if (!affected.length)
    throw new Error("Unsupported top-level insertion boundary");
  const originalList = projection.mapping.nodes.find(
    (entry) =>
      entry.node.type.name === "bullet_list" &&
      entry.from >= affected[0].from &&
      entry.to <= affected.at(-1)!.to,
  );
  const originalMarker = originalList
    ? (/^[-+*]/.exec(
        projection.text.slice(originalList.from, originalList.to),
      )?.[0] ?? "-")
    : "-";
  let content = Fragment.fromArray(next.content.content.slice(prefix, newEnd));
  const previous = affected[0].node,
    replacement = content.firstChild;
  if (
    affected.length === 1 &&
    content.childCount === 1 &&
    replacement &&
    ["bullet_list", "ordered_list"].includes(previous.type.name) &&
    previous.sameMarkup(replacement)
  ) {
    // Keep unchanged list items outside both the source patch and its guard.
    // A changed item still cannot contain a protected object.
    let first = 0,
      oldLast = previous.childCount,
      newLast = replacement.childCount;
    while (
      first < oldLast &&
      first < newLast &&
      previous.child(first).eq(replacement.child(first))
    )
      first++;
    while (
      oldLast > first &&
      newLast > first &&
      previous.child(oldLast - 1).eq(replacement.child(newLast - 1))
    ) {
      oldLast--;
      newLast--;
    }
    if (first < oldLast) {
      affected = previous.content.content.slice(first, oldLast).map((item) => {
        const mapped = projection.mapping.nodes.find(
          (entry) => entry.node === item,
        );
        if (!mapped) throw new Error("List item has no authoritative source range");
        return mapped;
      });
      content = Fragment.from(
        replacement.type.create(
          replacement.type.name === "ordered_list"
            ? { ...replacement.attrs, order: replacement.attrs.order + first }
            : replacement.attrs,
          replacement.content.content.slice(first, newLast),
          replacement.marks,
        ),
      );
    }
  }
  assertUnprotected(projection, affected[0].pos, affected.at(-1)!.end);
  const chunks: string[] = [];
  content.forEach((node) => {
    chunks.push(blockSource(node, projection, true, hint, originalMarker));
  });
  const from = affected[0].from,
    to = affected.at(-1)!.to;
  return {
    from,
    to,
    insert: chunks.join("\n\n"),
    expected: projection.text.slice(from, to),
  };
}

/** A heading shortcut changes only a source prefix. Keep inline islands as
 * exact source bytes, and require every projected child (including each atom's
 * identity, order and marks) to remain unchanged before bypassing range guards.
 * Multiline/nested rewrites still use the ordinary protected structural path. */
function protectedHeadingPatch(
  projection: FluidProjection,
  next: PMNode,
): SourcePatch | null {
  if (projection.doc.childCount !== next.childCount) return null;
  let changed = -1;
  for (let i = 0; i < next.childCount; i++) {
    if (projection.doc.child(i).eq(next.child(i))) continue;
    if (changed !== -1) return null;
    changed = i;
  }
  if (changed === -1) return null;
  const previous = projection.doc.child(changed), replacement = next.child(changed);
  const level: unknown = replacement.attrs.level;
  if (
    previous.type !== fluidSchema.nodes.paragraph ||
    replacement.type !== fluidSchema.nodes.heading ||
    typeof level !== "number" || !Number.isInteger(level) || level < 1 || level > 6 ||
    !previous.content.eq(replacement.content) ||
    !Mark.sameSet(previous.marks, replacement.marks) ||
    !previous.content.content.some(node => node.type === fluidSchema.nodes.inline_object)
  ) return null;
  const root = projection.mapping.roots[changed];
  if (!root || !root.node.eq(previous) || /[\r\n]/.test(projection.text.slice(root.from, root.to))) return null;
  return { from: root.from, to: root.from, insert: "#".repeat(level) + " ", expected: "" };
}

const stepShape = z
  .object({
    stepType: z.enum(["replace", "replaceAround", "addMark", "removeMark"]),
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative(),
  })
  .passthrough();
export async function prepareFluidTransaction(
  snapshot: DocumentSnapshot,
  projection: FluidProjection,
  steps: readonly unknown[],
  syntaxHint?: FluidSyntaxHint,
): Promise<{
  patches: SourcePatch[];
  text: string;
  projection: FluidProjection;
}> {
  const hint =
    syntaxHint === undefined
      ? undefined
      : z
          .union([
            z.object({ delimiter: z.enum(["*", "_", "**", "__"]) }).strict(),
            z.object({ marker: z.enum(["-", "*", "+"]) }).strict(),
          ])
          .parse(syntaxHint);
  if (
    snapshot.text !== projection.text ||
    snapshot.format !== projection.format
  )
    throw new Error("Stale source projection");
  if (!steps.length || steps.length > 256)
    throw new Error("Invalid transaction batch size");
  let candidate = projection;
  for (const json of steps) {
    const parsed = stepShape.parse(json);
    if (parsed.from > parsed.to || parsed.to > candidate.doc.content.size)
      throw new Error("Invalid projection step range");
    const step = Step.fromJSON(fluidSchema, parsed);
    const result = step.apply(candidate.doc);
    if (result.failed || !result.doc)
      throw new Error(result.failed ?? "Invalid projection step");
    const heading = protectedHeadingPatch(candidate, result.doc);
    if (!heading) assertUnprotected(candidate, parsed.from, parsed.to);
    const attempts: Array<() => SourcePatch> = [];
    if (heading) attempts.push(() => heading);
    if (step instanceof ReplaceStep) {
      const inlineOnly =
        step.slice.openStart === 0 &&
        step.slice.openEnd === 0 &&
        step.slice.content.content.every((node) => node.isInline);
      const split =
        parsed.from === parsed.to &&
        step.slice.openStart === 1 &&
        step.slice.openEnd === 1 &&
        step.slice.content.childCount === 2 &&
        !step.slice.content.textBetween(0, step.slice.content.size);
      if (inlineOnly || split)
        attempts.push(() =>
          inlinePatch(
            candidate,
            parsed.from,
            parsed.to,
            step.slice.content,
            split,
            hint,
          ),
        );
    } else if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) {
      attempts.push(() =>
        inlinePatch(
          candidate,
          parsed.from,
          parsed.to,
          result.doc!.slice(parsed.from, parsed.to).content,
          false,
          hint,
        ),
      );
    }
    attempts.push(() => structuralPatch(candidate, result.doc!, hint));
    let accepted: FluidProjection | undefined, failure: unknown;
    for (const attempt of attempts) {
      try {
        const patch = attempt();
        const updated = applySourcePatches(
          { ...snapshot, text: candidate.text },
          snapshot.revision,
          [patch],
        );
        const projected = await projectFluidSource(
          updated.text,
          snapshot.format,
          candidate.components,
        );
        if (!projected.doc.eq(result.doc))
          throw new Error(
            "Source projection differs from proposed editor transaction",
          );
        accepted = projected;
        break;
      } catch (error) {
        failure = error;
      }
    }
    if (!accepted) throw failure ?? new Error("Unsupported source transaction");
    candidate = accepted;
  }
  // Compose all temporary edits into one exact source change only after every
  // step has passed. No caller can observe a partially accepted transaction.
  let from = 0,
    oldTo = snapshot.text.length,
    newTo = candidate.text.length;
  while (
    from < oldTo &&
    from < newTo &&
    snapshot.text[from] === candidate.text[from]
  )
    from++;
  while (
    oldTo > from &&
    newTo > from &&
    snapshot.text[oldTo - 1] === candidate.text[newTo - 1]
  ) {
    oldTo--;
    newTo--;
  }
  const patches =
    from === oldTo && from === newTo
      ? []
      : [
          {
            from,
            to: oldTo,
            insert: candidate.text.slice(from, newTo),
            expected: snapshot.text.slice(from, oldTo),
          },
        ];
  return { patches, text: candidate.text, projection: candidate };
}
