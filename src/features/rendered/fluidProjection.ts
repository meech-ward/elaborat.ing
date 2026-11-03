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
import { z } from "zod/mini";
import { en } from "zod/locales";
import type { FluidSyntaxHint } from "./protocol";
import {
  compileProjection,
  type ComponentSlot,
  type Instrumentation,
} from "./instrumentation";
import { fluidSchema } from "./fluidSchema";
import { codeFenceOpener } from "./fluidCommands";
import { changeTo, rebaseSteps, sameMarkdownForm } from "./nearestForm";
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
  /** A list item's task box, from remark-gfm. */
  checked?: boolean | null;
  /** For an empty task item's paragraph: what typing there writes first. */
  pad?: string;
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
  /** An inline island's formatting, which text typed at its edges is written inside. */
  frames?: Frame[];
  /**
   * An island's source as written at the start of a line, without its
   * container's prefix on its later lines: what the serializer writes for it
   * in another place. Absent when that cannot be exact (`islandCopy`).
   */
  copy?: string;
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
  /** Source written before the first text typed into this empty leaf. */
  pad?: string;
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
  /**
   * The note's code outside its islands: format, workspace modules, ESM and
   * frontmatter. The frame keeps the islands an edit did not change while
   * this stays the same (preview-entry.tsx).
   */
  scopeKey: string;
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
/**
 * The column a list item's blocks start at, as CommonMark reads it: after
 * its marker and one to four spaces, or one past the marker when the line
 * has nothing else or more spaces follow. Null inside a quote or with a tab,
 * where the prefix is not plain spaces.
 */
function contentColumn(text: string, from: number): number | null {
  const start = text.lastIndexOf("\n", from - 1) + 1;
  const line = text.slice(from, (text.indexOf("\n", from) + 1 || text.length + 1) - 1);
  const marker = /^(?:[-+*]|\d{1,9}[.)])([ \t]*)/.exec(line);
  if (!marker || /[\t>]/.test(text.slice(start, from) + marker[1])) return null;
  const spaces = marker[1].length;
  const width = !line.slice(marker[0].length).trim() || spaces >= 5 ? 1 : spaces;
  return from - start + marker[0].length - marker[1].length + width;
}

/**
 * An island's source as its container holds it, at the start of a line: its
 * own indentation past the `column` its container's blocks start at, then
 * its lines without the `column` spaces the container puts before each.
 * Written into any container, the island holds exactly what it held.
 * Undefined when the container's prefix is not `column` spaces on every
 * line (a quote, a tab), or for an inline island on more than one line; an
 * island on one line is its source as it is.
 */
function islandCopy(text: string, from: number, to: number, column: number | null): string | undefined {
  const source = text.slice(from, to);
  if (!source.includes("\n")) return source;
  const own = from - (text.lastIndexOf("\n", from - 1) + 1) - (column ?? 0);
  if (column === null || own < 0 || /[^ ]/.test(text.slice(from - own, from))) return undefined;
  const indent = " ".repeat(column);
  const lines = source.split("\n");
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].startsWith(indent)) lines[i] = lines[i].slice(column);
    else if (/^ *\r?$/.test(lines[i])) lines[i] = lines[i].replace(/^ */, "");
    else return undefined;
  }
  return " ".repeat(own) + lines.join("\n");
}

/**
 * The source of a node from `from` to `to` as written at the start of a
 * line: each later line without the prefix (list indentation, quote markers)
 * that its first line has before the node, so a writer can put the node into
 * another container and add that container's own. A line without the prefix,
 * such as a paragraph's lazy line, keeps what it has.
 */
function detached(text: string, from: number, to: number): string {
  const start = text.lastIndexOf("\n", from - 1) + 1;
  const prefix = text.slice(start, from).replace(/[^\s>]/g, " ");
  const source = text.slice(from, to);
  if (!prefix) return source;
  return source
    .split("\n")
    .map((line, i) => {
      if (!i) return line;
      let at = 0;
      while (at < prefix.length && line[at] === prefix[at]) at++;
      return line.slice(at);
    })
    .join("\n");
}

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
    let decoded = code
      ? token.replace(/\r\n?|\n/g, " ")
      : decodeString(token).replace(/\r\n?/g, "\n");
    // Spaces and tabs before a line break are absent from the parser's text
    // value too: they go with the line break, so text typed at the end of
    // the line is written before them.
    const suffix = !code && value[output] === "\n" ? /^[ \t]+(?:\r\n?|\n)/.exec(remaining)?.[0] : undefined;
    if (suffix) {
      token = suffix;
      decoded = "\n";
    }
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

/** A task item's box in its source: the list marker, spaces, then `[ ]` or `[x]`. */
const TASK_BOX = /^(?:[-+*]|\d{1,9}[.)])[ \t]+\[([ xX])\]/;

/**
 * A list item's task box and the children to show under it. An item with
 * nothing after its box ("- [ ] ") is not a task item to the parser, which
 * keeps the box as text, so it shows as an empty task item: a task's text
 * can be cleared, and a new one started, without the box turning into text.
 */
function taskItem(
  ast: Ast,
  text: string,
): { checked: boolean | null; children: Ast[] } {
  const children = ast.children ?? [];
  const head = children[0];
  if (typeof ast.checked === "boolean") {
    // The parser starts the item's paragraph after its box, except when the
    // text opens with formatting ("- [ ] **Bold**"): start it there too.
    const from = head?.type === "paragraph" ? range(head).from : -1;
    const box = from < 0 ? null : /^\[[ xX]\][ \t]*/.exec(text.slice(from, range(head).to));
    if (!box) return { checked: ast.checked, children };
    const start = { offset: from + box[0].length };
    return {
      checked: ast.checked,
      children: [{ ...head, position: { start, end: head.position!.end } }, ...children.slice(1)],
    };
  }
  const only =
    head?.type === "paragraph" && head.children?.length === 1
      ? head.children[0]
      : undefined;
  if (!head || only?.type !== "text") return { checked: null, children };
  const box = /^\[([ xX])\]$/.exec(
    text.slice(range(only).from, range(only).to),
  );
  const end = range(head).to;
  if (!box || !/^[ \t]*$/.test(text.slice(range(only).to, end)))
    return { checked: null, children };
  const empty: Ast = {
    type: "paragraph",
    children: [],
    // Text typed after a box with no space after it needs one.
    pad: /[ \t]$/.test(text.slice(0, end)) ? undefined : " ",
    position: { start: { offset: end }, end: { offset: end } },
  };
  return { checked: box[1] !== " ", children: [empty, ...children.slice(1)] };
}

export async function projectFluidSource(
  text: string,
  format: DocumentFormat,
  environment?: ComponentEnvironment,
): Promise<FluidProjection> {
  const components = environment ?? (format === 'mdx' ? await prepareComponentEnvironment(text) : {source:text,catalog:COMPONENT_CATALOG,modules:[],key:'',code:[]});
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
    frames: Frame[] = [],
    column: number | null = null,
  ): PMNode => {
    const { from, to } = range(ast);
    // An inline island on more than one line keeps its source in place.
    const copy = islandCopy(text, from, to, inline ? null : column);
    // Named by what it holds, so an island written into another container
    // (Shift+Tab on its item) keeps its name, and a change to what it holds
    // does not.
    const hash = islandHash(copy ?? text.slice(from, to));
    const count = occurrences.get(hash) ?? 0;
    occurrences.set(hash, count + 1);
    const id = `island:${hash}:${count}`;
    islands.push({ id, from, to, inline });
    islandAsts.push(ast);
    const node = fluidSchema.node(
      inline ? "inline_object" : "object",
      { id },
      undefined,
      Mark.setFrom(frames.map((frame) => frame.mark)),
    );
    nodes.push({
      node, ast, from, to, pos, end: pos + node.nodeSize, root,
      ...(inline ? { frames } : {}),
      ...(copy === undefined ? {} : { copy }),
    });
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
      // The parser keeps a line break's own characters in the value: the
      // editor shows it as "\n" in text and as a space in a code span, as
      // the source mapping below reads it.
      const value =
        ast.type === "inlineCode"
          ? (ast.value ?? "").replace(/\r\n?|\n/g, " ")
          : (ast.value ?? "").replace(/\r\n?/g, "\n");
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
    return [island(ast, true, pos, root, frames)];
  };
  const isContainer = (ast: Ast): boolean =>
    ["list", "listItem", "blockquote"].includes(ast.type);
  const isPlainBlock = (ast: Ast): boolean =>
    ["paragraph", "heading", "thematicBreak"].includes(ast.type);
  /** `column`: where its container's blocks start (`contentColumn`), null in a quote. */
  const block = (ast: Ast, pos: number, root: number, column: number | null = 0): PMNode => {
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
          ...(ast.pad ? { pad: ast.pad } : {}),
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
      const task = ast.type === "listItem" ? taskItem(ast, text) : null;
      const content: PMNode[] = [];
      let at = pos + 1;
      // An empty paragraph right after the item's (or quote's) marker, where
      // typing writes its text. After a bare "-" that text needs a space.
      const emptyHead = () => {
        const marker = /^(?:[-+*]|\d{1,9}[.)]|>)[ \t]*/.exec(text.slice(from))?.[0] ?? "";
        const empty: Ast = {
          type: "paragraph",
          children: [],
          ...(ast.type === "listItem" && !/[ \t]$/.test(marker) ? { pad: " " } : {}),
          position: {
            start: { offset: from + marker.length },
            end: { offset: from + marker.length },
          },
        };
        const node = block(empty, at, root);
        content.push(node);
        at += node.nodeSize;
      };
      const children = task?.children ?? ast.children ?? [];
      // An item that does not open with a paragraph. With nothing else on its
      // marker's line, that line is an empty paragraph, so Enter at the end of
      // an item can move what follows into a new one ("- \n  - b"). A block
      // on the marker's line itself ("- ```js", "- - b") is shown as an
      // island, and the item's other blocks and its list stay editable.
      const head =
        ast.type === "listItem" && children[0]?.type !== "paragraph"
          ? children[0]
          : undefined;
      const headLine = head && !/\n/.test(text.slice(from, range(head).from));
      if (head && !headLine) emptyHead();
      const inner =
        ast.type === "listItem" ? contentColumn(text, from) : ast.type === "list" ? column : null;
      for (const child of children) {
        const next =
          (child !== head || !headLine) && (isPlainBlock(child) || isContainer(child))
            ? block(child, at, root, inner)
            : island(child, false, at, root, [], inner);
        content.push(next);
        at += next.nodeSize;
      }
      if (!content.length) emptyHead();
      // A list item opens with its paragraph or an island; a list holds only
      // items. Any other shape (prose directly under a list) keeps the
      // previous whole-container island instead of violating the schema.
      const shapeValid =
        (ast.type === "list" &&
          content.every((entry) => entry.type.name === "list_item")) ||
        (ast.type === "listItem" &&
          ["paragraph", "object"].includes(content[0]?.type.name ?? "")) ||
        ast.type === "blockquote";
      let built: PMNode | undefined;
      if (shapeValid) {
        try {
          built = fluidSchema.node(
            name,
            ast.type === "list" && ast.ordered
              ? { order: ast.start ?? 1 }
              : task
                ? { checked: task.checked }
                : null,
            content,
          );
        } catch {
          built = undefined;
        }
      }
      if (!built) {
        rollback();
        return island(ast, false, pos, root, [], column);
      }
      node = built;
    } else return island(ast, false, pos, root, [], column);
    nodes.push({ node, ast, from, to, pos, end: pos + node.nodeSize, root });
    return node;
  };
  // One parse: the instrumentation is read from the same compile, before its
  // preview markers.
  const { code, instrumentation } = await compileProjection(text, format, {
    before(tree, captured) {
      const content: PMNode[] = [];
      let pos = 0;
      const sourceChildren = (tree as Ast).children ?? [];
      const gapOffsets = captured.blocks
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
                // The compiler makes this React's key: an island keeps its
                // state while islands before it come and go.
                {
                  type: "mdxJsxAttribute",
                  name: "key",
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
  const scopeKey = islandHash(
    JSON.stringify({
      format,
      modules: components.key,
      scope: retained
        .filter((ast) => ["mdxjsEsm", "yaml", "toml"].includes(ast.type))
        .map((ast) => {
          const { from, to } = range(ast);
          return text.slice(from, to);
        }),
    }),
  );
  return {
    components,
    text,
    format,
    doc,
    code,
    slots: instrumentation.components,
    islands,
    instrumentation,
    runtimeKey,
    scopeKey,
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
/**
 * Where text written at `position` goes when no text is there: at the edge of
 * the inline island (an image, a component) beside it, inside the island's
 * formatting. `side` says which island wins where two touch: "start" the one
 * after the position, "end" the one before it.
 */
function islandEdge(
  projection: FluidProjection,
  position: number,
  side: "start" | "end",
): { raw: number; frames: Frame[] } | undefined {
  const inline = projection.mapping.nodes.filter(
    (entry) => entry.node.type === fluidSchema.nodes.inline_object,
  );
  const after = inline.find((entry) => entry.pos === position),
    before = inline.find((entry) => entry.end === position);
  const edge =
    side === "start"
      ? after && { raw: after.from, frames: after.frames ?? [] }
      : before && { raw: before.to, frames: before.frames ?? [] };
  return (
    edge ??
    (side === "start"
      ? before && { raw: before.to, frames: before.frames ?? [] }
      : after && { raw: after.from, frames: after.frames ?? [] })
  );
}
export function fluidSourceOffsetForPosition(
  projection: FluidProjection,
  position: number,
  assoc: -1 | 1 = 1,
): number | null {
  const leaf = leafAt(projection, position, assoc);
  if (leaf) return leaf.boundaries[position - leaf.pos] ?? null;
  return islandEdge(projection, position, assoc === 1 ? "start" : "end")?.raw ?? null;
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

/**
 * Where the blocks start whose source starts at `offset` or later: the
 * position of the first of them, so every block from there on comes from
 * that source. Null when none does (the source there is inside a block that
 * starts before it, such as an open code fence).
 */
export function fluidBlockPositionFrom(
  projection: FluidProjection,
  offset: number,
): number | null {
  let first: number | null = null;
  for (const entry of projection.mapping.nodes) {
    if (entry.node.isInline || entry.from < offset) continue;
    if (first === null || entry.pos < first) first = entry.pos;
  }
  return first;
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
/** A delimiter `inlineSource` wrote: where in its output, and whether it opens a mark. */
type Delimiter = { at: number; text: string; opens: boolean };
function inlineSource(
  content: Fragment,
  format: DocumentFormat,
  start: SyntaxFrame[] = [],
  end: SyntaxFrame[] = [],
  preserve?: FluidProjection,
  hint?: FluidSyntaxHint,
  delimiters?: Delimiter[],
): string {
  let active = start,
    output = "";
  const write = (text: string, opens: boolean) => {
    delimiters?.push({ at: output.length, text, opens });
    output += text;
  };
  const transition = (next: SyntaxFrame[]) => {
    let shared = 0;
    while (
      shared < active.length &&
      shared < next.length &&
      active[shared].mark.eq(next[shared].mark)
    )
      shared++;
    for (let i = active.length - 1; i >= shared; i--) write(active[i].close, false);
    for (let i = shared; i < next.length; i++) write(next[i].open, true);
    active = [...active.slice(0, shared), ...next.slice(shared)];
  };
  content.forEach((node) => {
    if (node.type.name === "hard_break") {
      transition([]);
      output += "\\\n";
      return;
    }
    if (node.type === fluidSchema.nodes.inline_object && preserve) {
      // An island the note already has, as it is written there.
      const known = islandEntry(preserve, node);
      transition(
        Mark.sameSet(known.node.marks, node.marks) && known.frames
          ? known.frames
          : node.marks.map(
              (mark) =>
                [...active, ...start, ...end].find((frame) => frame.mark.eq(mark)) ??
                canonicalFrame(mark, hint),
            ),
      );
      output += islandSource(known);
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
  const edge = leaf ? undefined : islandEdge(projection, position, side);
  if (!leaf && !edge) throw new Error("Unsupported structural endpoint");
  let raw = leaf ? leaf.boundaries[position - leaf.pos] : edge!.raw;
  if (raw == null) throw new Error("Cannot split an encoded source character");
  let frames = leaf ? leaf.frames : edge!.frames;
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
/** The note's island `node` stands for: one with its name, which the editor cannot make up. */
function islandEntry(projection: FluidProjection, node: PMNode): MappedNode {
  const known = projection.mapping.nodes.find(
    (entry) => entry.node.type === node.type && entry.node.attrs.id === node.attrs.id,
  );
  if (!known) throw new Error("Selection crosses a protected object");
  return known;
}
/** An island's source to write in another place, when that is exact. */
function islandSource(entry: MappedNode): string {
  if (entry.copy === undefined) throw new Error("Selection crosses a protected object");
  return entry.copy;
}
const islandsOf = (doc: PMNode) => {
  const found: PMNode[] = [];
  doc.descendants((node) => {
    if (node.type === fluidSchema.nodes.object || node.type === fluidSchema.nodes.inline_object)
      found.push(node);
  });
  return found;
};
/**
 * A change that moves blocks (Enter, Tab, joining items) may move islands
 * with them, which the serializer writes as they are, but keeps every one,
 * in the same order and with the same formatting: it never drops, copies,
 * makes, reorders or formats one.
 */
function assertIslandsKept(before: PMNode, after: PMNode) {
  const kept = islandsOf(before),
    now = islandsOf(after);
  if (kept.length !== now.length || kept.some((node, i) => !node.eq(now[i])))
    throw new Error("Selection crosses a protected object");
}
/** A source change that writes only part of an island's source would change the island. */
function assertIslandsWhole(projection: FluidProjection, patch: SourcePatch) {
  for (const island of projection.islands)
    if (
      patch.from < island.to &&
      patch.to > island.from &&
      (patch.from > island.from || patch.to < island.to)
    )
      throw new Error("Selection crosses a protected object");
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
  assertRenderedBetween(projection, from, to);
}
/** Source the note does not show (exports, comments) between the blocks from `from` to `to`. */
function assertRenderedBetween(
  projection: FluidProjection,
  from: number,
  to: number,
) {
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
/** Formatting written with `*`, `_` or `~` delimiters. */
const DELIMITED = ["em", "strong", "strike"];
function inlinePatch(
  projection: FluidProjection,
  from: number,
  to: number,
  content: Fragment,
  split = false,
  hint?: FluidSyntaxHint,
  flank = false,
): SourcePatch {
  assertUnprotected(projection, from, to);
  const start = endpoint(projection, from, "start", from !== to);
  const end = from === to ? start : endpoint(projection, to, "end", true);
  let insert: string;
  let sourceTo = end.raw;
  const delimiters: Delimiter[] = [];
  if (split) {
    insert =
      start.frames
        .slice()
        .reverse()
        .map((frame) => frame.close)
        .join("") +
      "\n\n" +
      start.frames.map((frame) => frame.open).join("");
    // Spaces or tabs right after the split would start the new paragraph,
    // where Markdown drops them (and after a reopened `*`, keep it from
    // opening): they leave the source too, the nearest form Markdown can
    // store. In a code span or a link's text they are kept, as written.
    if (start.frames.every((frame) => DELIMITED.includes(frame.mark.type.name)))
      sourceTo += /^[ \t]*/.exec(projection.text.slice(start.raw))![0].length;
  } else
    insert = inlineSource(
      content,
      projection.format,
      start.frames,
      end.frames,
      undefined,
      hint,
      delimiters,
    );
  let lead = 0;
  if (start.leaf?.pad && insert && !split) {
    insert = start.leaf.pad + insert;
    lead = start.leaf.pad.length;
  }
  let sourceFrom = start.raw;
  const blank = insert && !split && from === to ? blankBeforeEmptyItem(projection, from) : null;
  if (blank) {
    const written = blank.insert + projection.text.slice(blank.to, start.raw);
    insert = written + insert;
    lead += written.length;
    sourceFrom = blank.from;
  }
  const emptyRoot = projection.mapping.roots.find(
    (root) => root.pos + 1 === from && root.from === root.to,
  );
  // A byte order mark alone is not a block to separate from.
  const before = projection.text.slice(0, start.raw).replace(/^﻿/, "");
  if (
    emptyRoot &&
    before !== "" &&
    !/(?:\r?\n){2}[ \t]*$/.test(before)
  ) {
    insert = "\n\n" + insert;
    lead += 2;
  }
  const patch = {
    from: sourceFrom,
    to: sourceTo,
    insert,
    expected: projection.text.slice(sourceFrom, sourceTo),
  };
  return flank
    ? flanked(
        projection.text,
        patch,
        delimiters.map((delimiter) => ({ ...delimiter, at: delimiter.at + lead })),
      )
    : patch;
}

/**
 * The blank line before a nested list whose first item is empty at
 * `position` (`requiredGap`), as the source to write in its place once that
 * item has text: the same line break without the blank line. Null when the
 * list spaces its nested lists with blank lines anyway, or the source there
 * is another shape.
 */
function blankBeforeEmptyItem(
  projection: FluidProjection,
  position: number,
): { from: number; to: number; insert: string } | null {
  const $pos = projection.doc.resolve(position);
  if ($pos.depth < 4 || $pos.parent.content.size || $pos.index(-1) !== 0 || $pos.index(-2) !== 0) return null;
  const item = $pos.node(-1),
    list = $pos.node(-2),
    parent = $pos.node(-3);
  if (item.type !== fluidSchema.nodes.list_item || parent.type !== fluidSchema.nodes.list_item || !isList(list)) return null;
  const index = $pos.index(-3);
  if (!index || requiredGap(parent, index) !== "\n\n") return null;
  if (list.type === fluidSchema.nodes.ordered_list && list.attrs.order !== 1) return null;
  const source = (node: PMNode) => projection.mapping.nodes.find((entry) => entry.node === node);
  const before = source(parent.child(index - 1)),
    after = source(list);
  if (!before || !after) return null;
  const gap = projection.text.slice(before.to, after.from);
  if (!blankLine(gap)) return null;
  // Spaced as the lists around it are, from the outermost in (listItemsPatch).
  let style = TIGHT;
  for (let depth = 1; depth < $pos.depth - 4; depth++) {
    const node = $pos.node(depth);
    if (!isList(node)) continue;
    const own = listStyle(projection, node, style);
    style = { ...own, loose: own.nested };
  }
  if (listStyle(projection, $pos.node(-4), style).nested) return null;
  const second = list.childCount > 1 ? source(list.child(1)) : undefined,
    first = source(item);
  if (second && first && blankLine(projection.text.slice(first.to, second.from))) return null;
  const lines = gap.split("\n");
  return { from: before.to, to: after.from, insert: `${lines[0]}\n${lines.at(-1)}` };
}

/** How Markdown's parser sees a character next to `*`, `_` or `~` (micromark's classifyCharacter). */
function flankClass(char: string | undefined): "space" | "punctuation" | "other" {
  if (char === undefined || /\s/.test(char)) return "space";
  return /\p{P}|\p{S}/u.test(char) ? "punctuation" : "other";
}

/**
 * Whether a run of `*`, `_` or `~` between `before` and `after` can open
 * (and close) what it should: CommonMark's flanking rules, as micromark's
 * attention construct applies them. A closing `*` cannot follow a space, nor
 * follow punctuation and come before a letter; `_` cannot open or close inside
 * a word.
 */
function flanks(
  before: string | undefined,
  after: string | undefined,
  run: { opens: boolean; closes: boolean; underscore: boolean },
): boolean {
  const left = flankClass(before),
    right = flankClass(after);
  const open = right === "other" || (right === "punctuation" && left !== "other");
  const close = left === "other" || (left === "punctuation" && right !== "other");
  const opens = run.underscore ? open && (left !== "other" || !close) : open;
  const closes = run.underscore ? close && (right !== "other" || !open) : close;
  return (!run.opens || opens) && (!run.closes || closes);
}

/**
 * The patch with each emphasis, strong or strikethrough delimiter it writes
 * placed where Markdown reads it as one. Deleting from the start of a word
 * inside italics to plain text after them leaves the closing `*` between a
 * space and a letter, where it closes nothing (`*a *b`). The spaces go just
 * outside the italics (`*a* b`): Markdown cannot hold them inside, so this is
 * the edit's nearest form, which the editor takes in place of its own
 * (prepareFluidTransaction). Where punctuation, not a space, is beside the
 * letter (`*"*b`), the letter is written as a numeric reference, which the
 * parser reads as punctuation and the note shows as the same letter
 * (`*"*&#98;`), so the source keeps exactly the text and formatting shown.
 */
function flanked(
  text: string,
  patch: SourcePatch,
  delimiters: readonly Delimiter[],
): SourcePatch {
  let out = text.slice(0, patch.from) + patch.insert + text.slice(patch.to);
  // Touching delimiters are one run to the parser.
  const runs: { from: number; to: number; opens: boolean; closes: boolean; underscore: boolean }[] = [];
  for (const delimiter of delimiters) {
    if (!/^[*_~]+$/.test(delimiter.text)) continue;
    const from = patch.from + delimiter.at,
      to = from + delimiter.text.length,
      last = runs.at(-1);
    const run = last?.to === from ? last : { from, to, opens: false, closes: false, underscore: false };
    if (run !== last) runs.push(run);
    run.to = to;
    run.opens ||= delimiter.opens;
    run.closes ||= !delimiter.opens;
    run.underscore ||= delimiter.text.includes("_");
  }
  let changed = false;
  // Right to left, so a reference written or a space moved after a run never moves one before it.
  for (const run of runs.reverse()) {
    const before = () => Array.from(out.slice(Math.max(0, run.from - 2), run.from)).at(-1);
    const after = () => Array.from(out.slice(run.to, run.to + 2))[0];
    const encode = (side: "before" | "after") => {
      const char = side === "before" ? before() : after();
      if (char === undefined) return;
      const reference = `&#${char.codePointAt(0)};`;
      changed = true;
      if (side === "after") {
        out = out.slice(0, run.to) + reference + out.slice(run.to + char.length);
        return;
      }
      out = out.slice(0, run.from - char.length) + reference + out.slice(run.from);
      run.from += reference.length - char.length;
      run.to += reference.length - char.length;
    };
    if (flanks(before(), after(), run)) continue;
    // Spaces or tabs just inside a run that only closes, or only opens, go
    // just outside it, out of the formatting.
    if (run.closes !== run.opens) {
      let from = run.from,
        to = run.to;
      if (run.closes) while (from > 0 && /[ \t]/.test(out[from - 1])) from--;
      else while (to < out.length && /[ \t]/.test(out[to])) to++;
      const spaces = out.slice(from, run.from) + out.slice(run.to, to);
      if (spaces) {
        const delimiter = out.slice(run.from, run.to);
        out = out.slice(0, from) + (run.closes ? delimiter + spaces : spaces + delimiter) + out.slice(to);
        run.from = run.closes ? from : from + spaces.length;
        run.to = run.from + delimiter.length;
        changed = true;
      }
      if (flanks(before(), after(), run)) continue;
    }
    // A space or tab where a run that closes and opens may not have one:
    // written as a reference, it reads as punctuation.
    if (run.closes && /^[ \t]$/.test(before() ?? "")) encode("before");
    if (run.opens && /^[ \t]$/.test(after() ?? "")) encode("after");
    if (flanks(before(), after(), run)) continue;
    // Punctuation on one side and a letter on the other (or letters on both
    // sides of `_`): the letter as a reference, so both sides are punctuation.
    if (run.closes && flankClass(after()) === "other") encode("after");
    if (run.opens && flankClass(before()) === "other") encode("before");
  }
  if (!changed) return patch;
  // The patch is the change from the text to the result.
  let from = 0,
    oldTo = text.length,
    newTo = out.length;
  while (from < oldTo && from < newTo && text[from] === out[from]) from++;
  while (oldTo > from && newTo > from && text[oldTo - 1] === out[newTo - 1]) {
    oldTo--;
    newTo--;
  }
  return { from, to: oldTo, insert: out.slice(from, newTo), expected: text.slice(from, oldTo) };
}

/**
 * How a written list marks its items and spaces them: `delimiter` keeps an
 * ordered marker's dot or closing parenthesis, `loose` puts a blank line
 * between items, `nested` one between an item's text and its nested list.
 * `numbering` says how an ordered list counts: "sequential" (1, 2, 3), "same"
 * (every item 1.), or "kept" when its numbers follow no rule, so each item
 * keeps its own.
 */
type ListStyle = {
  marker: string;
  delimiter: string;
  loose: boolean;
  nested: boolean;
  numbering: "sequential" | "same" | "kept";
};
const TIGHT: ListStyle = { marker: "-", delimiter: ".", loose: false, nested: false, numbering: "sequential" };
const LIST_MARKER = /^(?:[-+*]|\d{1,9}[.)])/;
const isList = (node: PMNode) =>
  node.type === fluidSchema.nodes.bullet_list ||
  node.type === fluidSchema.nodes.ordered_list;
const blankLine = (source: string) => /\n[ \t>]*\n/.test(source);

/**
 * How `list`, a list in the source, writes items: with its bullet, spaced
 * like `gap` (the source between two of its items, by default its first
 * two), and with nested lists set off as its own are, else like its items.
 * What the source does not show comes from `fallback`.
 */
function listStyle(
  projection: FluidProjection,
  list: PMNode,
  fallback: ListStyle,
  gap?: string,
): ListStyle {
  const text = projection.text;
  const source = (node: PMNode) =>
    projection.mapping.nodes.find((entry) => entry.node === node);
  const first = source(list.firstChild!),
    second = list.childCount > 1 ? source(list.child(1)) : undefined;
  if (gap === undefined && first && second)
    gap = text.slice(first.to, second.from);
  const loose = gap === undefined ? fallback.loose : blankLine(gap);
  let nested: boolean | undefined;
  for (const item of list.content.content)
    for (let i = 1; i < item.childCount && nested === undefined; i++) {
      const before = source(item.child(i - 1)),
        after = source(item.child(i));
      // A gap Markdown requires says nothing about the author's spacing.
      if (isList(item.child(i)) && before && after && requiredGap(item, i) === null)
        nested = blankLine(text.slice(before.to, after.from));
    }
  const numbers = list.content.content.map((item) => {
    const entry = source(item);
    return entry ? Number(/^\d+/.exec(text.slice(entry.from))?.[0]) : NaN;
  });
  return {
    marker: (first && /^[-+*]/.exec(text.slice(first.from))?.[0]) || fallback.marker,
    delimiter: (first && /^\d+([.)])/.exec(text.slice(first.from))?.[1]) || fallback.delimiter,
    loose,
    nested: nested ?? loose,
    numbering:
      list.type !== fluidSchema.nodes.ordered_list
        ? fallback.numbering
        : numbers.every((number, i) => number === numbers[0] + i)
          ? "sequential"
          : numbers.every((number) => number === numbers[0])
            ? "same"
            : "kept",
  };
}

/**
 * The marker item `index` of `list` is written with: the list's bullet, or
 * its number and delimiter. The first item of an ordered list carries the
 * list's start, as Markdown reads it; the others count on from it, or keep
 * the list's one number, or (in a list whose numbers follow no rule) the
 * number `source`, the item's source, already has.
 */
function itemMarker(
  list: PMNode,
  index: number,
  style: ListStyle,
  source?: string,
): string {
  if (list.type !== fluidSchema.nodes.ordered_list) return style.marker;
  const kept = source && /^(\d{1,9})[.)]/.exec(source)?.[1];
  const number =
    index === 0 || style.numbering === "same"
      ? list.attrs.order
      : style.numbering === "kept" && kept
        ? Number(kept)
        : list.attrs.order + index;
  return `${number}${style.delimiter}`;
}

/**
 * An item's source with `marker` in place of the one it starts with. Its
 * later lines move by the change in width, so its blocks stay in the item;
 * the space after the marker stays as written.
 */
function withMarker(source: string, marker: string): string {
  const old = LIST_MARKER.exec(source)?.[0];
  if (old === undefined || old === marker) return source;
  const delta = marker.length - old.length;
  return source
    .split("\n")
    .map((line, i) =>
      !i
        ? marker + line.slice(old.length)
        : delta > 0
          ? line && " ".repeat(delta) + line
          : line.slice(Math.min(-delta, /^ */.exec(line)![0].length)),
    )
    .join("\n");
}

/**
 * The gap Markdown requires before block `index` of list item `item`, or
 * null when it may be tight or loose. With no text on the marker's line, the
 * item's blocks start on the next line: a blank line there would end the
 * item. After text, a nested list whose first item is empty, or an ordered
 * one not starting at 1, cannot interrupt the paragraph (a bare "-" under it
 * would make it a heading), so a blank line goes before it.
 */
function requiredGap(item: PMNode, index: number): string | null {
  const before = item.child(index - 1),
    child = item.child(index);
  if (before.type !== fluidSchema.nodes.paragraph) return null;
  const box = index === 1 && item.attrs.checked !== null;
  if (!before.content.size && !box) return index === 1 ? "\n" : null;
  if (!isList(child)) return null;
  const first = child.firstChild!;
  return (child.type === fluidSchema.nodes.ordered_list && child.attrs.order !== 1) ||
    (first.attrs.checked === null && first.firstChild?.type === fluidSchema.nodes.paragraph && !first.firstChild.content.size)
    ? "\n\n"
    : null;
}

/**
 * Backspace or Delete that joins items of an ordered list numbered 1, 2, 3
 * (written in place, as typing is): the changes to the numbers of the items
 * after the join, so they count on as they do after Enter (listItemsPatch).
 * None where a number would change width in an item of more than one line,
 * whose lines would have to move.
 */
function countingOn(projection: FluidProjection, from: number, to: number): SourcePatch[] {
  const $from = projection.doc.resolve(from),
    $to = projection.doc.resolve(to);
  const depth = $from.sharedDepth(to);
  const list = $from.node(depth);
  const removed = $to.index(depth) - $from.index(depth);
  if (
    list.type !== fluidSchema.nodes.ordered_list ||
    removed < 1 ||
    listStyle(projection, list, TIGHT).numbering !== "sequential"
  )
    return [];
  const patches: SourcePatch[] = [];
  for (let i = $to.index(depth) + 1; i < list.childCount; i++) {
    const entry = projection.mapping.nodes.find((candidate) => candidate.node === list.child(i));
    const digits = entry && /^\d{1,9}/.exec(projection.text.slice(entry.from))?.[0];
    if (!entry || !digits) return [];
    const number = String(list.attrs.order + i - removed);
    if (number.length !== digits.length && projection.text.slice(entry.from, entry.to).includes("\n")) return [];
    patches.push({ from: entry.from, to: entry.from + digits.length, insert: number, expected: digits });
  }
  return patches;
}

/** Source changes that do not overlap, as one. */
function joined(text: string, patches: readonly SourcePatch[]): SourcePatch {
  const sorted = [...patches].sort((a, b) => a.from - b.from);
  let insert = "";
  for (const [i, patch] of sorted.entries())
    insert += (i ? text.slice(sorted[i - 1].to, patch.from) : "") + patch.insert;
  const from = sorted[0].from,
    to = sorted.at(-1)!.to;
  return { from, to, insert, expected: text.slice(from, to) };
}

/**
 * Where block `node` of an edit's document is in the note's source: the
 * block itself, where the edit kept it, else an equal block the edit took
 * out of its place (one a step moved and so made again). A block still in
 * the edited document (`stays`) is not where another came from: an equal
 * list elsewhere in the note can be spaced or marked another way, which the
 * document does not show.
 */
function sourceOf(projection: FluidProjection, node: PMNode, stays: ReadonlySet<PMNode>): MappedNode | undefined {
  return (
    projection.mapping.nodes.find((entry) => entry.node === node) ??
    projection.mapping.nodes.find((entry) => !stays.has(entry.node) && entry.node.eq(node))
  );
}

/** Every block of `doc`, to tell the blocks an edit kept from those it moved (`sourceOf`). */
function blocksOf(doc: PMNode): Set<PMNode> {
  const blocks = new Set<PMNode>();
  doc.descendants((node) => {
    blocks.add(node);
    return !node.isTextblock;
  });
  return blocks;
}

/**
 * The line breaks between two blocks where the source has them side by side
 * (one right after the other in the same container), so an item's blocks
 * stay as close as they were written: "\n" or "\n\n".
 */
function sourceGap(projection: FluidProjection, before: PMNode, after: PMNode, stays: ReadonlySet<PMNode>): string | undefined {
  const above = sourceOf(projection, before, stays),
    below = sourceOf(projection, after, stays);
  if (!above || !below || above.to > below.from) return undefined;
  const gap = projection.text.slice(above.to, below.from);
  if (!/^[ \t]*\r?\n[\s>]*$/.test(gap)) return undefined;
  return blankLine(gap) ? "\n\n" : "\n";
}

/**
 * Whether block `after` can start on the line right after block `before`,
 * so an item's blocks need no blank line between them (which would make its
 * list loose): a paragraph after a heading or a closed code fence, and a
 * heading, a quote or a code fence after a paragraph. A paragraph after a
 * quote or a list would continue it, and an unclosed fence would take it in.
 */
function followsTightly(projection: FluidProjection, before: PMNode, after: PMNode): boolean {
  const { paragraph, heading, blockquote, object } = fluidSchema.nodes;
  // An island is known by its source: a block opening with a fence is a
  // code block, and one opening with "#" and a space is a heading.
  const source = (node: PMNode) => {
    if (node.type !== object) return "";
    const entry = islandEntry(projection, node);
    return entry.copy ?? detached(projection.text, entry.from, entry.to);
  };
  const atx = (node: PMNode) => node.type === heading || /^ {0,3}#{1,6}(?:[ \t]|$)/.test(source(node));
  const fence = (node: PMNode) => {
    const code = source(node);
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(code)?.[1];
    if (!open) return null;
    const close = /\n {0,3}(`+|~+)[ \t]*$/.exec(code)?.[1];
    return close?.[0] === open[0] && close.length >= open.length ? "closed" : "open";
  };
  if (after.type === paragraph) return atx(before) || fence(before) === "closed";
  return before.type === paragraph && (atx(after) || after.type === blockquote || fence(after) !== null);
}

/** One item of `list`: an unchanged item exactly as written, or its marker, box and blocks. */
function itemSource(
  list: PMNode,
  index: number,
  projection: FluidProjection,
  hint: FluidSyntaxHint | undefined,
  style: ListStyle,
  stays: ReadonlySet<PMNode>,
): string {
  const item = list.child(index);
  const unchanged = sourceOf(projection, item, stays);
  // An unchanged item as written, with the marker of the list it is in now
  // (Tab or Shift+Tab moves items between lists).
  if (unchanged) {
    const source = detached(projection.text, unchanged.from, unchanged.to);
    return withMarker(source, itemMarker(list, index, style, source));
  }
  const marker = `${itemMarker(list, index, style)} `;
  const box =
    item.attrs.checked === null ? "" : item.attrs.checked ? "[x] " : "[ ] ";
  let body = "";
  item.forEach((child, _, i) => {
    // Two blocks the source has side by side keep the line breaks between
    // them. In a tight list, a nested list can start on the line after the
    // item's text, except an ordered one not starting at 1, which cannot
    // interrupt a paragraph, and so can other blocks that may (`followsTightly`).
    if (i)
      body +=
        requiredGap(item, i) ??
        sourceGap(projection, item.child(i - 1), child, stays) ??
        (!style.nested &&
        (child.type === fluidSchema.nodes.bullet_list ||
          (child.type === fluidSchema.nodes.ordered_list && child.attrs.order === 1) ||
          followsTightly(projection, item.child(i - 1), child))
          ? "\n"
          : "\n\n");
    body += blockSource(
      child,
      projection,
      stays,
      true,
      hint,
      isList(child) ? { ...style, loose: style.nested } : style,
    );
  });
  return body
    .split("\n")
    .map((line, i) =>
      i === 0 ? marker + box + line : line && " ".repeat(marker.length) + line,
    )
    .join("\n");
}

/** Serialize only a changed, parser-owned ordinary subtree. Exact unchanged
 * sibling subtrees are reused; this never serializes the document. `stays`:
 * the edited document's blocks (`sourceOf`). `avoid`: bullets or delimiters
 * a list may not use, those of a list of its kind beside it. */
function blockSource(
  node: PMNode,
  projection: FluidProjection,
  stays: ReadonlySet<PMNode>,
  reuse = true,
  hint?: FluidSyntaxHint,
  style: ListStyle = TIGHT,
  avoid: readonly string[] = [],
): string {
  if (node.type === fluidSchema.nodes.object) {
    // An island with no copy for another place (its lines carry a quote's
    // markers) is written as its quote holds it. Its name is that source, so
    // one moved where its lines would change is refused by the check.
    const entry = islandEntry(projection, node);
    return entry.copy ?? detached(projection.text, entry.from, entry.to);
  }
  const old = reuse && !avoid.length ? sourceOf(projection, node, stays) : undefined;
  if (old) return detached(projection.text, old.from, old.to);
  // Markdown drops spaces and tabs at the start of a paragraph or heading, so
  // they are not written (the editor takes the document without them).
  const text = () =>
    inlineSource(node.content, projection.format, [], [], projection, hint).replace(/^[ \t]+/, "");
  switch (node.type.name) {
    case "paragraph":
      return text();
    case "heading":
      return "#".repeat(node.attrs.level) + " " + text();
    case "horizontal_rule":
      return "---";
    case "blockquote": {
      const parts: string[] = [];
      node.forEach((child) => {
        parts.push(blockSource(child, projection, stays, true, hint, style));
      });
      return parts
        .join("\n\n")
        .split("\n")
        .map((line) => "> " + line)
        .join("\n");
    }
    case "bullet_list":
    case "ordered_list": {
      // Spaced like the list its first kept item comes from.
      const kept = node.content.content
        .map((item) => sourceOf(projection, item, stays))
        .find(Boolean);
      const original =
        kept &&
        projection.mapping.nodes.find(
          (entry) => isList(entry.node) && entry.node.content.content.includes(kept.node),
        );
      const spaced = original ? listStyle(projection, original.node, style) : style;
      // A bullet typed at the start of a line (`hint`) marks the list it
      // makes, whose items are all new; other lists keep their own.
      const made =
        node.type === fluidSchema.nodes.bullet_list &&
        !node.content.content.some((item) => projection.mapping.nodes.some((entry) => entry.node === item));
      const marker = made && hint && "marker" in hint ? hint.marker : spaced.marker;
      // Beside a list of its kind, another bullet or delimiter keeps the two apart.
      const own = {
        ...spaced,
        marker: avoid.includes(marker)
          ? (["-", "*", "+"].find((bullet) => !avoid.includes(bullet)) ?? marker)
          : marker,
        delimiter: avoid.includes(spaced.delimiter)
          ? ([".", ")"].find((delimiter) => !avoid.includes(delimiter)) ?? spaced.delimiter)
          : spaced.delimiter,
      };
      const parts: string[] = [];
      node.forEach((_, __, index) => {
        parts.push(itemSource(node, index, projection, hint, own, stays));
      });
      return parts.join(own.loose ? "\n\n" : "\n");
    }
    default:
      throw new Error("Unsupported structural serialization");
  }
}

/**
 * An edit inside a list (Enter, Tab, Shift+Tab, joining items) writes only
 * the items it changed, in the innermost list holding them. The rest of the
 * list keeps its source exactly, and new items are spaced like their
 * neighbours, so a list with blank lines between its items keeps them and a
 * list without stays without. A changed item still cannot contain a
 * protected object. Null when the list's source cannot say where items go
 * (an item without a source range, or other source between items).
 */
function listItemsPatch(
  projection: FluidProjection,
  previous: PMNode,
  next: PMNode,
  stays: ReadonlySet<PMNode>,
  hint?: FluidSyntaxHint,
): SourcePatch | null {
  const text = projection.text;
  let context = TIGHT;
  for (;;) {
    let first = 0,
      oldLast = previous.childCount,
      newLast = next.childCount;
    while (
      first < oldLast &&
      first < newLast &&
      previous.child(first).eq(next.child(first))
    )
      first++;
    while (
      oldLast > first &&
      newLast > first &&
      previous.child(oldLast - 1).eq(next.child(newLast - 1))
    ) {
      oldLast--;
      newLast--;
    }
    if (first === oldLast && first === newLast) return null;
    // One item changed only in its nested list: the edit is in that list.
    if (oldLast === first + 1 && newLast === first + 1) {
      const before = previous.child(first),
        after = next.child(first);
      let changed = -1;
      if (before.sameMarkup(after) && before.childCount === after.childCount)
        before.forEach((child, _, i) => {
          if (!child.eq(after.child(i))) changed = changed === -1 ? i : -2;
        });
      const gap = () => {
        const above = projection.mapping.nodes.find((entry) => entry.node === before.child(changed - 1)),
          list = projection.mapping.nodes.find((entry) => entry.node === before.child(changed));
        return above && list ? text.slice(above.to, list.from) : "";
      };
      if (
        changed >= 0 &&
        isList(before.child(changed)) &&
        before.child(changed).sameMarkup(after.child(changed)) &&
        (requiredGap(after, changed) !== "\n\n" || blankLine(gap()))
      ) {
        const parent = listStyle(projection, previous, context);
        context = { ...parent, loose: parent.nested };
        previous = before.child(changed);
        next = after.child(changed);
        continue;
      }
    }
    const items: MappedNode[] = [];
    for (const item of previous.content.content) {
      const mapped = projection.mapping.nodes.find((entry) => entry.node === item);
      if (!mapped) return null;
      items.push(mapped);
    }
    const gaps = items
      .slice(1)
      .map((item, i) => text.slice(items[i].to, item.from));
    if (gaps.some((gap) => !/^\s*$/.test(gap))) return null;
    // A nested list's lines start at its column ("- - a" opens one on its
    // parent's line, so the column is spaces). A byte order mark before the
    // note's first line takes no column.
    const columns = (from: number) =>
      text
        .slice(text.lastIndexOf("\n", from - 1) + 1, from)
        .replace(/^﻿/, "")
        .replace(/\S/g, " ");
    const indent = columns(items[0].from);
    // New items are spaced like the items next to the edit.
    const near: string | undefined =
      gaps[Math.min(Math.max(first - (oldLast > first ? 0 : 1), 0), gaps.length - 1)];
    const style = listStyle(projection, previous, context, near);
    const gap = near ?? (style.loose ? "\n\n" : "\n") + indent;
    const reindent = (source: string, by = indent) =>
      source
        .split("\n")
        .map((line, j) => (j && line ? by + line : line))
        .join("\n");
    // In a list numbered 1, 2, 3, the items after the change count on: each
    // is written again on its own, changing only its number (and the indent
    // of its later lines when the number's width changes), so the gaps
    // between them, and the indent of its own line, stay as written.
    const counted: SourcePatch[] = [];
    if (next.type === fluidSchema.nodes.ordered_list && style.numbering === "sequential")
      for (let i = newLast; i < next.childCount; i++) {
        const entry = items[i - newLast + oldLast];
        if (Number(/^\d+/.exec(text.slice(entry.from))?.[0]) === next.attrs.order + i) continue;
        counted.push({
          from: entry.from,
          to: entry.to,
          insert: reindent(itemSource(next, i, projection, hint, style, stays), columns(entry.from)),
          expected: text.slice(entry.from, entry.to),
        });
      }
    const written: string[] = [];
    for (let i = first; i < newLast; i++) {
      written.push(reindent(itemSource(next, i, projection, hint, style, stays)));
    }
    let insert = written.join(gap),
      from: number,
      to: number;
    if (oldLast > first) {
      from = items[first].from;
      to = items[oldLast - 1].to;
      // Removed items take a gap with them.
      if (!written.length) {
        if (first > 0) from = items[first - 1].to;
        else if (oldLast < items.length) to = items[oldLast].from;
        else return null;
      }
    } else if (first > 0) {
      from = to = items[first - 1].to;
      insert = gap + insert;
    } else {
      from = to = items[0].from;
      insert += gap;
    }
    return joined(text, [{ from, to, insert, expected: text.slice(from, to) }, ...counted]);
  }
}

/**
 * The top-level blocks a step changed, written again. `separate` puts a
 * blank line between them and a block on the line next to them, where the
 * change would otherwise run into it (a paragraph would continue the list
 * before it, a bare "-" would underline the paragraph before it): null when
 * there is no such block.
 */
function structuralPatch(
  projection: FluidProjection,
  next: PMNode,
  hint?: FluidSyntaxHint,
  separate = false,
): SourcePatch | null {
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
  const affected = projection.mapping.roots.slice(prefix, oldEnd);
  if (!affected.length) {
    if (separate) return null;
    const added = next.content.content.slice(prefix, newEnd);
    if (added.length === 1 && added[0].type === fluidSchema.nodes.paragraph && !added[0].content.size)
      return blankParagraphPatch(projection, prefix);
    throw new Error("Unsupported top-level insertion boundary");
  }
  const originalList = projection.mapping.nodes.find(
    (entry) =>
      entry.node.type.name === "bullet_list" &&
      entry.from >= affected[0].from &&
      entry.to <= affected.at(-1)!.to,
  );
  const originalOrderedList = projection.mapping.nodes.find(
    (entry) =>
      entry.node.type.name === "ordered_list" &&
      entry.from >= affected[0].from &&
      entry.to <= affected.at(-1)!.to,
  );
  const style: ListStyle = {
    ...TIGHT,
    marker: originalList
      ? (/^[-+*]/.exec(
          projection.text.slice(originalList.from, originalList.to),
        )?.[0] ?? "-")
      : "-",
    delimiter: originalOrderedList
      ? (/^\d+([.)])/.exec(projection.text.slice(originalOrderedList.from, originalOrderedList.to))?.[1] ?? ".")
      : ".",
  };
  const content = Fragment.fromArray(next.content.content.slice(prefix, newEnd));
  const stays = blocksOf(next);
  const previous = affected[0].node,
    replacement = content.firstChild;
  if (
    !separate &&
    affected.length === 1 &&
    content.childCount === 1 &&
    replacement &&
    isList(previous) &&
    previous.sameMarkup(replacement)
  ) {
    const patch = listItemsPatch(projection, previous, replacement, stays, hint);
    if (patch) return patch;
  }
  assertRenderedBetween(projection, affected[0].pos, affected.at(-1)!.end);
  const blank = (node: PMNode) => node.type === fluidSchema.nodes.paragraph && !node.content.size;
  /** The marker a list's source starts with: its bullet, or its delimiter. */
  const markerOf = (source: string) => {
    const marker = LIST_MARKER.exec(source)?.[0] ?? "";
    return /^\d/.test(marker) ? marker.slice(-1) : marker;
  };
  const chunks: string[] = [];
  content.forEach((node, _, index) => {
    // A list beside one of its kind, with only empty paragraphs between,
    // would join it: Enter on an empty middle item leaves two lists.
    const avoid: string[] = [];
    if (isList(node)) {
      let j = index - 1;
      while (j >= 0 && blank(content.child(j))) j--;
      if (j >= 0) {
        if (content.child(j).type === node.type) avoid.push(markerOf(chunks[j]));
      } else {
        let root = prefix - 1;
        while (root >= 0 && blank(projection.doc.child(root))) root--;
        if (root >= 0 && projection.doc.child(root).type === node.type)
          avoid.push(markerOf(projection.text.slice(projection.mapping.roots[root].from)));
      }
      let k = index + 1;
      while (k < content.childCount && blank(content.child(k))) k++;
      if (k === content.childCount) {
        let root = oldEnd;
        while (root < projection.doc.childCount && blank(projection.doc.child(root))) root++;
        if (root < projection.doc.childCount && projection.doc.child(root).type === node.type)
          avoid.push(markerOf(projection.text.slice(projection.mapping.roots[root].from)));
      }
    }
    chunks.push(blockSource(node, projection, stays, true, hint, style, avoid));
  });
  const from = affected[0].from,
    to = affected.at(-1)!.to;
  let insert = chunks.join("\n\n");
  const breaks = (space: string) => space.split("\n").length - 1;
  const before = breaks(/\s*$/.exec(projection.text.slice(0, from))![0]),
    after = breaks(/^\s*/.exec(projection.text.slice(to))![0]),
    following = oldEnd < projection.doc.childCount;
  const first = content.firstChild,
    last = content.lastChild;
  // An empty paragraph is blank lines, four line breaks between blocks
  // (blankParagraphPatch): at the start of the change, or at its end before
  // a block, the source around it gives the rest.
  if (content.childCount > 1 && blank(first!))
    insert = "\n".repeat(Math.max(0, 2 - before)) + insert;
  if (content.childCount > 1 && blank(last!) && following)
    insert += "\n".repeat(Math.max(0, 2 - after));
  if (separate) {
    const lead = !!first && prefix > 0 && before === 1 && !blank(first),
      trail = !!last && following && after === 1 && !blank(last);
    if (!lead && !trail) return null;
    insert = (lead ? "\n" : "") + insert + (trail ? "\n" : "");
  }
  return {
    from,
    to,
    insert,
    expected: projection.text.slice(from, to),
  };
}

/**
 * An empty paragraph added before top-level block `index` of the note, or
 * after the last: Enter at the start of a heading or of the note's first
 * paragraph, or on a selected table. Markdown has no empty paragraph, so it
 * is blank lines, as Enter at the end of a paragraph writes it: four line
 * breaks before the next block (a gap, which projects as an empty paragraph),
 * or two at the end of the note.
 */
function blankParagraphPatch(projection: FluidProjection, index: number): SourcePatch {
  const following = projection.mapping.roots[index];
  const at = following ? following.from : projection.text.length;
  const blank = /\s*$/.exec(projection.text.slice(0, at))![0];
  const breaks = blank.split("\n").length - 1;
  const insert = "\n".repeat(Math.max(0, (following ? 4 : 2) - breaks));
  return { from: at, to: at, insert, expected: "" };
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

/**
 * Ticking a task item's box changes only the character inside it, and giving
 * an item a box (typing `[ ] ` at its start) writes one before its text, so
 * the rest of the item stays as written. Null for any other change at `pos`.
 */
function taskBoxPatch(
  projection: FluidProjection,
  next: PMNode,
  pos: number,
): SourcePatch | null {
  const before = projection.doc.nodeAt(pos),
    after = next.nodeAt(pos);
  if (
    before?.type !== fluidSchema.nodes.list_item ||
    after?.type !== before.type ||
    !before.content.eq(after.content) ||
    typeof after.attrs.checked !== "boolean" ||
    before.attrs.checked === after.attrs.checked
  )
    return null;
  const find = (node: PMNode | null, at: number) =>
    projection.mapping.nodes.find((entry) => entry.pos === at && entry.node === node);
  if (before.attrs.checked === null) {
    const first = find(before.firstChild, pos + 1);
    if (!first) return null;
    const insert = after.attrs.checked ? "[x] " : "[ ] ";
    return { from: first.from, to: first.from, insert, expected: "" };
  }
  const item = find(before, pos);
  const box = item && TASK_BOX.exec(projection.text.slice(item.from, item.to));
  if (!item || !box) return null;
  const at = item.from + box[0].length - 2;
  return {
    from: at,
    to: at + 1,
    insert: after.attrs.checked ? "x" : " ",
    expected: projection.text.slice(at, at + 1),
  };
}

/**
 * A top-level paragraph that is only a typed code fence opening (```js)
 * becomes an empty code block: its source is replaced by the fence, and
 * `focus` is the offset inside it, where the code goes. Null for any other
 * node at `pos`.
 */
export function codeFenceFromParagraph(
  projection: FluidProjection,
  pos: number,
): { patch: SourcePatch; focus: number } | null {
  const root = projection.mapping.roots.find((entry) => entry.pos === pos);
  const opener = root ? codeFenceOpener(root.node) : null;
  if (!root || !opener) return null;
  const open = opener.ticks + opener.info;
  return {
    patch: {
      from: root.from,
      to: root.to,
      insert: `${open}\n${opener.ticks}`,
      expected: projection.text.slice(root.from, root.to),
    },
    focus: root.from + open.length + 1,
  };
}

const stepShape = z.looseObject({
  stepType: z.enum(["replace", "replaceAround", "addMark", "removeMark"]),
  from: z.int().check(z.nonnegative()),
  to: z.int().check(z.nonnegative()),
});
/** Zod's English messages, which a refused step's error shows (zod/mini has none of its own). */
const english = { error: en().localeError };
/**
 * The editor's steps as one change of the note's source. Each step is written
 * the first way whose source reads back as exactly the document the step made,
 * so every edit Markdown can hold is written as it always was. When none does,
 * the step's nearest form is taken: a way whose document differs from the
 * step's only by whitespace Markdown cannot hold (nearestForm.ts), or no
 * change at all when that is all the step did (a space typed at the start of a
 * paragraph). `nearest` then says where a position in the editor's document
 * is in the one the source makes, which the editor takes in place of its own;
 * it is null when the two are the same.
 */
export async function prepareFluidTransaction(
  snapshot: DocumentSnapshot,
  projection: FluidProjection,
  steps: readonly unknown[],
  syntaxHint?: FluidSyntaxHint,
): Promise<{
  patches: SourcePatch[];
  text: string;
  projection: FluidProjection;
  nearest: ((pos: number) => number) | null;
}> {
  const hint =
    syntaxHint === undefined
      ? undefined
      : z
          .union([
            z.strictObject({ delimiter: z.enum(["*", "_", "**", "__"]) }),
            z.strictObject({ marker: z.enum(["-", "*", "+"]) }),
          ])
          .parse(syntaxHint, english);
  if (
    snapshot.text !== projection.text ||
    snapshot.format !== projection.format
  )
    throw new Error("Stale source projection");
  if (!steps.length || steps.length > 256)
    throw new Error("Invalid transaction batch size");
  // The steps as the editor made them, one after another from the document shown.
  const proposed = steps.map((json) =>
    Step.fromJSON(fluidSchema, stepShape.parse(json, english)),
  );
  // The steps still to write, made on `candidate.doc`: the editor's own until
  // one is taken in its nearest form, then redone on that.
  let queue = proposed;
  let candidate = projection;
  let nearest = false;
  for (let index = 0; index < queue.length; index++) {
    const step = queue[index];
    // Each text this step's attempts wrote, projected once. The format and the
    // component environment stay the same through the transaction, so the text
    // decides it. Kept for one step only: a transaction can have hundreds of
    // steps, and each projection holds the whole note.
    const projections = new Map<string, Promise<FluidProjection>>();
    const { from, to } = step as unknown as { from: number; to: number };
    if (from > to || to > candidate.doc.content.size)
      throw new Error("Invalid projection step range");
    const result = step.apply(candidate.doc);
    if (result.failed || !result.doc)
      throw new Error(result.failed ?? "Invalid projection step");
    const heading = protectedHeadingPatch(candidate, result.doc);
    // A task box patch touches only the box, so an item holding an island can be ticked too.
    const task = heading ? null : taskBoxPatch(candidate, result.doc, from);
    // A delete or typing: inline content in place of a range.
    const inline =
      step instanceof ReplaceStep &&
      step.slice.openStart === 0 &&
      step.slice.openEnd === 0 &&
      step.slice.content.content.every((node) => node.isInline)
        ? step.slice.content
        : null;
    const formatted = step instanceof AddMarkStep || step instanceof RemoveMarkStep;
    // Typing, a delete or a format change over an island would change it;
    // a change that moves blocks may move islands, which are written as
    // they are, but must keep every one of them.
    if (!heading && !task) {
      if (inline || formatted) assertUnprotected(candidate, from, to);
      else {
        assertRenderedBetween(candidate, from, to);
        assertIslandsKept(candidate.doc, result.doc);
      }
    }
    // An attempt that does not apply to this step gives null.
    const attempts: Array<() => SourcePatch | null> = [];
    if (heading) attempts.push(() => heading);
    if (task) attempts.push(() => task);
    if (step instanceof ReplaceStep) {
      const split =
        from === to &&
        step.slice.openStart === 1 &&
        step.slice.openEnd === 1 &&
        step.slice.content.childCount === 2 &&
        !step.slice.content.textBetween(0, step.slice.content.size);
      if (inline || split)
        attempts.push(() =>
          joined(candidate.text, [
            inlinePatch(candidate, from, to, step.slice.content, split, hint),
            ...countingOn(candidate, from, to),
          ]),
        );
    }
    // Bold, italics or another format added or taken off: the text with its new formatting.
    const marked = formatted ? result.doc.slice(from, to).content : null;
    if (marked)
      attempts.push(() => inlinePatch(candidate, from, to, marked, false, hint));
    attempts.push(() => structuralPatch(candidate, result.doc!, hint));
    // Then a delete, typing or format change that leaves a formatting
    // delimiter where Markdown would not read it as one, with the spaces
    // beside it moved out of the formatting or the letter a reference (`flanked`).
    if (inline ?? marked)
      attempts.push(() =>
        joined(candidate.text, [
          inlinePatch(candidate, from, to, (inline ?? marked)!, false, hint, true),
          ...(inline ? countingOn(candidate, from, to) : []),
        ]),
      );
    // Last, the changed blocks set apart by a blank line from a block on the
    // line next to them, which they would otherwise run into.
    attempts.push(() => structuralPatch(candidate, result.doc!, hint, true));
    let accepted: FluidProjection | undefined,
      near: FluidProjection | undefined,
      failure: unknown;
    for (const attempt of attempts) {
      try {
        const patch = attempt();
        if (!patch) continue;
        assertIslandsWhole(candidate, patch);
        const updated = applySourcePatches(
          { ...snapshot, text: candidate.text },
          snapshot.revision,
          [patch],
        );
        let projecting = projections.get(updated.text);
        if (!projecting) {
          projecting = projectFluidSource(
            updated.text,
            snapshot.format,
            candidate.components,
          );
          projections.set(updated.text, projecting);
        }
        const projected = await projecting;
        if (projected.doc.eq(result.doc)) {
          accepted = projected;
          break;
        }
        if (!near && sameMarkdownForm(projected.doc, result.doc)) near = projected;
        throw new Error(
          "Source projection differs from proposed editor transaction",
        );
      } catch (error) {
        failure = error;
      }
    }
    if (!accepted) {
      accepted = sameMarkdownForm(candidate.doc, result.doc) ? candidate : near;
      if (!accepted) throw failure ?? new Error("Unsupported source transaction");
      nearest = true;
      // The editor made the steps after this one on its own document.
      const rest = rebaseSteps(queue.slice(index + 1), result.doc, accepted.doc);
      if (!rest)
        throw new Error("Source projection differs from proposed editor transaction");
      queue = [...queue.slice(0, index + 1), ...rest.steps];
    }
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
  let place: ((pos: number) => number) | null = null;
  if (nearest) {
    let editor = projection.doc;
    for (const step of proposed) {
      const next = step.apply(editor).doc;
      if (!next) throw new Error("Invalid projection step");
      editor = next;
    }
    if (!editor.eq(candidate.doc)) {
      const change = changeTo(editor, candidate.doc).mapping;
      place = (pos) => change.map(pos);
    }
  }
  return { patches, text: candidate.text, projection: candidate, nearest: place };
}
