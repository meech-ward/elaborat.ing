import { createProcessor } from "@mdx-js/mdx";
import remarkGfm from "remark-gfm";
import remarkFrontmatter from "remark-frontmatter";
import { decodeString } from "micromark-util-decode-string";
import { validateWorkspacePath } from "./index.ts";
import { parseDrawingFile } from "../drawings/parse.ts";

export interface MoveReferenceFile { path: string; content: string }
export interface MoveReferenceTarget { from: string; to: string }
export interface MoveReferencePlan {
  updates: { path: string; content: string; references: { from: string; to: string; line: number }[] }[];
  blockers: { path: string; reason: string }[];
}

type Node = {
  type: string;
  name?: string;
  url?: string;
  identifier?: string;
  value?: unknown;
  children?: Node[];
  attributes?: Node[];
  data?: { estree?: unknown };
  position?: { start: { offset?: number; line?: number }; end: { offset?: number } };
};
type Patch = { from: number; to: number; expected: string; insert: string };
const processors = {
  md: createProcessor({ format: "md", remarkPlugins: [remarkGfm, remarkFrontmatter] }),
  mdx: createProcessor({ format: "mdx", remarkPlugins: [remarkGfm, remarkFrontmatter] }),
};

function canonical(path: string): boolean {
  return validateWorkspacePath(path.split("/").map(encodeURIComponent).join("/")) === path;
}

function range(node: Node): { from: number; to: number } | null {
  const from = node.position?.start.offset;
  const to = node.position?.end.offset;
  return from !== undefined && to !== undefined ? { from, to } : null;
}

function whitespace(char: string | undefined): boolean {
  return char !== undefined && /\s/.test(char);
}

/** Find only the destination inside a parser-proven link/definition node. */
function destinationRange(source: string, node: Node): { from: number; to: number } | null {
  const bounds = range(node);
  if (!bounds) return null;
  let cursor = bounds.from;
  if (source[cursor] === "!") cursor++;
  if (source[cursor++] !== "[") return null;
  let depth = 1;
  while (cursor < bounds.to && depth) {
    if (source[cursor] === "\\") { cursor += 2; continue; }
    if (source[cursor] === "[") depth++;
    if (source[cursor] === "]") depth--;
    cursor++;
  }
  if (depth) return null;
  while (whitespace(source[cursor])) cursor++;
  if (source[cursor++] !== (node.type === "definition" ? ":" : "(")) return null;
  while (whitespace(source[cursor])) cursor++;
  const angle = source[cursor] === "<";
  if (angle) cursor++;
  const from = cursor;
  depth = 0;
  while (cursor < bounds.to) {
    const char = source[cursor];
    if (char === "\\") { cursor += 2; continue; }
    if (angle ? char === ">" : whitespace(char) || (char === ")" && depth === 0)) {
      return { from, to: cursor };
    }
    if (!angle && char === "(") depth++;
    if (!angle && char === ")") depth--;
    cursor++;
  }
  // A definition can end immediately after its unbracketed destination.
  return !angle && node.type === "definition" ? { from, to: cursor } : null;
}

function quotedRange(source: string, attribute: Node): { from: number; to: number; quote: string } | null {
  const bounds = range(attribute);
  if (!bounds) return null;
  let cursor = bounds.from;
  while (cursor < bounds.to && source[cursor] !== "=") cursor++;
  cursor++;
  while (whitespace(source[cursor])) cursor++;
  const quote = source[cursor++];
  if (quote !== '"' && quote !== "'") return null;
  const from = cursor;
  while (cursor < bounds.to && source[cursor] !== quote) cursor++;
  return cursor === bounds.to - 1 ? { from, to: cursor, quote } : null;
}

function jsxEncode(path: string, quote: string): string {
  return path.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll(quote, quote === '"' ? "&quot;" : "&#39;").replaceAll("\r", "&#13;").replaceAll("\n", "&#10;");
}

function external(value: string): boolean {
  return value.startsWith("#") || value.startsWith("/") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function literalExpression(value: unknown): string | null {
  const expression = object(value);
  if (!expression) return null;
  if (expression.type === "Literal" && typeof expression.value === "string") return expression.value;
  const program = object(object(expression.data)?.estree);
  const body = program?.body;
  return Array.isArray(body) && body.length === 1 ? literalExpression(object(body[0])?.expression) : null;
}

const WORKSPACE_IMPORT_PREFIX = "workspace:";

/** Absolute source range of an ESTree node, preferring `range` with `start`/`end` fallback. */
function estreeRange(node: Record<string, unknown>): { from: number; to: number } | null {
  const range = node.range;
  if (Array.isArray(range) && range.length === 2 && typeof range[0] === "number" && typeof range[1] === "number"
    && Number.isInteger(range[0]) && Number.isInteger(range[1]) && range[0] >= 0 && range[0] < range[1]) {
    return { from: range[0], to: range[1] };
  }
  const start = node.start;
  const end = node.end;
  if (typeof start === "number" && typeof end === "number"
    && Number.isInteger(start) && Number.isInteger(end) && start >= 0 && start < end) {
    return { from: start, to: end };
  }
  return null;
}

/** 1-based start line of an ESTree node, or null when unavailable. */
function estreeLine(node: Record<string, unknown>): number | null {
  const line = object(object(node.loc)?.start)?.line;
  return typeof line === "number" && Number.isInteger(line) && line >= 1 ? line : null;
}

/** Escape a JS string body for the given quote, retaining quote style. Backslashes and controls are escaped defensively. */
function jsStringEscape(value: string, quote: string): string {
  let out = "";
  for (const char of value) {
    if (char === "\\") out += "\\\\";
    else if (char === quote) out += `\\${quote}`;
    else if (char === "\n") out += "\\n";
    else if (char === "\r") out += "\\r";
    else if (char === "\t") out += "\\t";
    else if (char === "\b") out += "\\b";
    else if (char === "\f") out += "\\f";
    else if (char === "\v") out += "\\v";
    else if (char === "\u2028") out += "\\u2028";
    else if (char === "\u2029") out += "\\u2029";
    else {
      const code = char.codePointAt(0) ?? 0;
      out += code < 0x20 || code === 0x7f ? `\\x${code.toString(16).padStart(2, "0")}` : char;
    }
  }
  return out;
}

function resolvedRelative(owner: string, value: string): string {
  const segments = owner.split("/").slice(0, -1);
  for (const part of value.split("/")) {
    if (part === ".") continue;
    if (part === "..") { if (!segments.length) return ""; segments.pop(); }
    else segments.push(part);
  }
  return segments.join("/");
}

/** Offset of the first semantic URL suffix character, retaining its exact source spelling. */
function suffixOffset(raw: string): number {
  for (let cursor = 0; cursor < raw.length;) {
    let end = cursor + 1;
    if (raw[cursor] === "\\" && cursor + 1 < raw.length) end++;
    else if (raw[cursor] === "&") {
      const semicolon = raw.indexOf(";", cursor + 1);
      if (semicolon !== -1 && semicolon - cursor < 40) end = semicolon + 1;
    }
    const decoded = decodeString(raw.slice(cursor, end));
    if (decoded.startsWith("#") || decoded.startsWith("?")) return cursor;
    cursor = end;
  }
  return raw.length;
}

/** Attribute inspection is confined to parser-proven raw HTML nodes. It never produces patches. */
function htmlDestinations(html: string): string[] {
  const values: string[] = [];
  let cursor = 0;
  while (cursor < html.length) {
    const start = html.indexOf("<", cursor);
    if (start === -1) break;
    if (html.startsWith("<!--", start)) {
      const end = html.indexOf("-->", start + 4);
      cursor = end === -1 ? html.length : end + 3;
      continue;
    }
    cursor = start + 1;
    let tag = "";
    while (cursor < html.length && /[\w:-]/.test(html[cursor])) tag += html[cursor++];
    while (cursor < html.length && html[cursor] !== ">") {
      while (whitespace(html[cursor]) || html[cursor] === "/") cursor++;
      let name = "";
      while (cursor < html.length && /[\w:-]/.test(html[cursor])) name += html[cursor++];
      if (!name) { cursor++; continue; }
      while (whitespace(html[cursor])) cursor++;
      if (html[cursor] !== "=") continue;
      cursor++;
      while (whitespace(html[cursor])) cursor++;
      const quote = html[cursor] === '"' || html[cursor] === "'" ? html[cursor++] : null;
      const from = cursor;
      while (cursor < html.length && (quote ? html[cursor] !== quote : !whitespace(html[cursor]) && html[cursor] !== ">")) cursor++;
      if (tag !== "Drawing" && tag !== "Diagram" && ["src", "href"].includes(name.toLowerCase())) {
        values.push(decodeString(html.slice(from, cursor)));
      }
      if (quote && html[cursor] === quote) cursor++;
    }
    cursor++;
  }
  return values;
}

/** Narrow D2 scalar inspection: comments/quoted labels are skipped, only link/icon keys count.
 * Imports remain in D2's virtual FS; this is not a D2 dependency parser. */
function d2Destinations(source: string): string[] {
  const tokens: string[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === "#") {
      while (cursor < source.length && source[cursor] !== "\n") cursor++;
    } else if (char === "|") {
      // D2 block strings can use repeated pipes. Ignore the complete body.
      let delimiter = "";
      while (source[cursor] === "|") delimiter += source[cursor++];
      const end = source.indexOf(delimiter, cursor);
      cursor = end === -1 ? source.length : end + delimiter.length;
      tokens.push("<block string>");
    } else if (char === '"' || char === "'") {
      cursor++;
      let value = "";
      while (cursor < source.length && source[cursor] !== char) {
        if (source[cursor] === "\\" && cursor + 1 < source.length) cursor++;
        value += source[cursor++];
      }
      cursor++;
      tokens.push(value);
    } else if (":;{}\n".includes(char)) {
      tokens.push(char); cursor++;
    } else if (whitespace(char)) cursor++;
    else {
      const from = cursor;
      while (cursor < source.length && !whitespace(source[cursor]) && !":;{}\"'".includes(source[cursor])) cursor++;
      tokens.push(source.slice(from, cursor));
    }
  }
  const values: string[] = [];
  for (let i = 0; i + 2 < tokens.length; i++) {
    const key = tokens[i].split(".").at(-1);
    if ((key === "link" || key === "icon") && tokens[i + 1] === ":") {
      let value = tokens[i + 2];
      // A URL scheme was tokenized at its colon; keep it external.
      if (tokens[i + 3] === ":") value += ":" + (tokens[i + 4] ?? "");
      values.push(value);
    }
  }
  return values;
}

/** Parser-backed check for `workspace:` module imports referencing `target`.
 * ESTree literal values include JavaScript escapes; raw substring absence proves
 * nothing. Fenced/prose/external mentions never match. Unparseable MDX refuses
 * certification rather than guessing whether it contained a dependency.
 * Call only for `.mdx` content: `.md` import lines are prose, not ESM. */
export function referencesWorkspaceModule(content: string, target: string): boolean {
  const wanted = `${WORKSPACE_IMPORT_PREFIX}${target}`;
  const uncertain = (error: unknown): Error => {
    const raw = error instanceof Error ? error.message : String(error);
    const first = raw.split("\n", 1)[0]?.replace(/\s+/g, " ").trim() || "unparseable MDX";
    const reason = first.length > 200 ? `${first.slice(0, 200)}…` : first;
    return new Error(`Cannot certify workspace imports: ${reason}`);
  };
  let tree: Node;
  try {
    tree = processors.mdx.parse(content) as Node;
  } catch (error) {
    throw uncertain(error);
  }
  let found = false;
  const visitEstree = (value: unknown): void => {
    if (found) return;
    const record = object(value);
    if (!record) return;
    if (record.type === "ImportDeclaration" || record.type === "ExportNamedDeclaration" || record.type === "ExportAllDeclaration") {
      const src = object(record.source);
      if (src?.type === "Literal" && src.value === wanted) {
        found = true;
        return;
      }
    } else if (record.type === "ImportExpression") {
      const src = object(record.source);
      if (src?.type === "Literal" && src.value === wanted) {
        found = true;
        return;
      }
    } else if (record.type === "CallExpression" && object(record.callee)?.type === "Import" && Array.isArray(record.arguments)) {
      for (const arg of record.arguments) {
        const lit = object(arg);
        if (lit?.type === "Literal" && lit.value === wanted) {
          found = true;
          return;
        }
      }
    }
    for (const child of Object.values(record)) {
      if (found) return;
      if (Array.isArray(child)) {
        for (const entry of child) {
          visitEstree(entry);
          if (found) return;
        }
      } else if (object(child)) visitEstree(child);
    }
  };
  const walk = (node: Node): void => {
    if (found) return;
    if (node.data?.estree) visitEstree(node.data.estree);
    for (const child of node.children ?? []) {
      walk(child);
      if (found) return;
    }
  };
  try {
    walk(tree);
  } catch (error) {
    throw uncertain(error);
  }
  return found;
}

/** No filesystem access or mutation. Input strings must already be decoded as strict UTF-8. */
export function planMoveReferences(files: MoveReferenceFile[], moves: MoveReferenceTarget[]): MoveReferencePlan {
  const result: MoveReferencePlan = { updates: [], blockers: [] };
  const targets = new Map(moves.map((move) => [move.from, move.to]));
  const identities = new Set(files.map((file) => file.path));
  for (const move of moves) {
    identities.add(move.from);
    if (!canonical(move.from) || !canonical(move.to)) {
      result.blockers.push({ path: move.from, reason: "Move has an invalid canonical file identity" });
    }
  }
  for (const file of files) {
    const source = file.content;
    const patches: Patch[] = [];
    const references: MoveReferencePlan["updates"][number]["references"] = [];
    const block = (reason: string) => {
      if (!result.blockers.some((entry) => entry.path === file.path && entry.reason === reason)) {
        result.blockers.push({ path: file.path, reason });
      }
    };
    // Invalid input bytes must be refused before decoding by the IO owner. This
    // additional check catches callers supplying strings with unpaired surrogates.
    if (new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(new TextEncoder().encode(source)) !== source) {
      block("Cannot certify text that does not round-trip through UTF-8");
      continue;
    }
    const add = (slice: { from: number; to: number }, from: string, to: string, insert: string, node: Node, line?: number) => {
      patches.push({ ...slice, expected: source.slice(slice.from, slice.to), insert });
      references.push({ from, to, line: line ?? node.position?.start.line ?? 1 });
    };
    const markdownTarget = (url: string, kind = "link or image"): { from: string; to: string } | null => {
      if (external(url)) return null;
      if (url.startsWith("./") || url.startsWith("../")) {
        let relative = url.split(/[?#]/, 1)[0];
        try { relative = decodeURIComponent(relative); } catch { /* remains unsupported */ }
        if (targets.has(file.path) || targets.has(resolvedRelative(file.path, relative))) {
          block(`Unsupported document-relative ${kind} would be affected by this move`);
        }
        return null;
      }
      const bare = url.split(/[?#]/, 1)[0];
      let decoded: string;
      try { decoded = decodeURIComponent(bare); }
      catch {
        if (targets.has(bare)) block("Ambiguous or malformed percent encoding in a Markdown destination");
        return null;
      }
      const to = targets.get(decoded);
      if (bare !== decoded && identities.has(bare) && (to || targets.has(bare))) {
        block("Ambiguous Markdown destination matches both a literal-percent identity and a decoded identity");
        return null;
      }
      return to && canonical(decoded) ? { from: decoded, to } : null;
    };
    const unsupportedDestination = (url: string, kind: string) => {
      // A native/JSX file literal may contain # or ? as part of its identity.
      if (targets.has(url)) block(`Unsupported ${kind} refers to a moved file`);
      else if (markdownTarget(url, kind)) block(`Unsupported ${kind} refers to a moved file`);
    };
    const relevantKind = (name: string) => moves.some(({ from }) => name === "Diagram"
      ? /\.d2$/i.test(from)
      : /\.(excalidraw|excalidraw\.md|json)$/i.test(from));
    const resourceUnknown = (name: string, attrs: Node[]) => {
      const sources = attrs.filter((attr) => attr.name === "src");
      const spread = attrs.some((attr) => attr.type === "mdxJsxExpressionAttribute");
      const src = sources[0];
      const known = typeof src?.value === "string" ? src.value : literalExpression(src?.value);
      if (spread || sources.length > 1 || (src && known === null)) {
        if (relevantKind(name)) block("Unsupported computed or spread resource reference has an unresolved target");
      } else if (known !== null && targets.has(known) && typeof src?.value !== "string") {
        block("Unsupported computed resource src refers to a moved file");
      }
    };
    const inspectExecutable = (value: unknown, owner: Node) => {
      const record = object(value);
      if (!record) return;
      if (record.type === "ImportDeclaration") {
        const src = object(record.source);
        if (src?.type === "Literal" && typeof src.value === "string" && src.value.startsWith(WORKSPACE_IMPORT_PREFIX)) {
          const from = src.value.slice(WORKSPACE_IMPORT_PREFIX.length);
          const to = targets.get(from);
          if (to !== undefined && canonical(from) && canonical(to)) {
            const specifiers = Array.isArray(record.specifiers) ? record.specifiers : [];
            const namedOnly = specifiers.length > 0 && specifiers.every((entry) => object(entry)?.type === "ImportSpecifier");
            const attributed = [record.attributes, record.assertions].some((field) => Array.isArray(field) && field.length > 0);
            if (!namedOnly || attributed) {
              block("Unsupported workspace import form refers to a moved file");
            } else {
              const slice = estreeRange(src);
              const raw = typeof src.raw === "string" ? src.raw : null;
              const quote = raw?.[0] ?? "";
              if (!slice || slice.to > source.length || raw === null || source.slice(slice.from, slice.to) !== raw
                || (quote !== "'" && quote !== '"') || raw[raw.length - 1] !== quote) {
                block("Cannot safely position this workspace import");
              } else {
                add(slice, from, to, `${quote}${jsStringEscape(`${WORKSPACE_IMPORT_PREFIX}${to}`, quote)}${quote}`, owner, estreeLine(record) ?? undefined);
              }
            }
          }
        }
      } else if (record.type === "ExportNamedDeclaration" || record.type === "ExportAllDeclaration") {
        const src = object(record.source);
        if (src?.type === "Literal" && typeof src.value === "string" && src.value.startsWith(WORKSPACE_IMPORT_PREFIX)
          && targets.has(src.value.slice(WORKSPACE_IMPORT_PREFIX.length))) {
          block("Unsupported workspace re-export refers to a moved file");
        }
      } else if (record.type === "ImportExpression") {
        const src = object(record.source);
        if (src?.type === "Literal" && typeof src.value === "string" && src.value.startsWith(WORKSPACE_IMPORT_PREFIX)
          && targets.has(src.value.slice(WORKSPACE_IMPORT_PREFIX.length))) {
          block("Unsupported dynamic workspace import refers to a moved file");
        }
      } else if (record.type === "CallExpression" && object(record.callee)?.type === "Import" && Array.isArray(record.arguments)) {
        for (const arg of record.arguments) {
          const lit = object(arg);
          if (lit?.type === "Literal" && typeof lit.value === "string" && lit.value.startsWith(WORKSPACE_IMPORT_PREFIX)
            && targets.has(lit.value.slice(WORKSPACE_IMPORT_PREFIX.length))) {
            block("Unsupported dynamic workspace import refers to a moved file");
          }
        }
      } else if (record.type === "JSXOpeningElement") {
        const name = object(record.name)?.name;
        const attrs = Array.isArray(record.attributes) ? record.attributes : [];
        if (name === "Drawing" || name === "Diagram") {
          let known: string | null = null;
          let uncertain = false;
          for (const attr of attrs) {
            const entry = object(attr);
            if (entry?.type === "JSXSpreadAttribute") uncertain = true;
            if (object(entry?.name)?.name === "src") {
              const src = object(entry?.value);
              known = literalExpression(src?.type === "JSXExpressionContainer" ? src.expression : src);
              if (known === null) uncertain = true;
            }
          }
          if ((known !== null && targets.has(known)) || (uncertain && relevantKind(name))) {
            block("Unsupported resource tag inside executable expression or export");
          }
        } else {
          for (const attr of attrs) {
            const entry = object(attr);
            if (["src", "href"].includes(String(object(entry?.name)?.name))) {
              const value = object(entry?.value);
              const url = literalExpression(value?.type === "JSXExpressionContainer" ? value.expression : value);
              if (url !== null) unsupportedDestination(url, "executable JSX destination");
            }
          }
        }
      }
      for (const child of Object.values(record)) {
        if (Array.isArray(child)) child.forEach((entry) => inspectExecutable(entry, owner));
        else if (object(child)) inspectExecutable(child, owner);
      }
    };
    const imageDefinitions = new Set<string>();
    const collectImageDefinitions = (node: Node) => {
      if (node.type === "imageReference" && node.identifier) imageDefinitions.add(node.identifier);
      for (const child of node.children ?? []) collectImageDefinitions(child);
    };
    const visit = (node: Node) => {
      if ((node.type === "link" || node.type === "definition" || node.type === "image") && typeof node.url === "string") {
        const target = markdownTarget(node.url);
        if (target) {
          if (node.type === "image" || (node.type === "definition" && node.identifier && imageDefinitions.has(node.identifier))) {
            block("Unsupported image destination refers to a moved file");
          }
          else {
            const slice = destinationRange(source, node);
            if (!slice || decodeString(source.slice(slice.from, slice.to)) !== node.url) {
              block("Cannot safely position this Markdown destination");
            } else {
              // Retain the original suffix spelling, including Markdown escapes/entities.
              const raw = source.slice(slice.from, slice.to);
              const insert = target.to.split("/").map((segment) => encodeURIComponent(segment)
                .replaceAll("(", "%28").replaceAll(")", "%29")).join("/") + raw.slice(suffixOffset(raw));
              add(slice, target.from, target.to, insert, node);
            }
          }
        }
      }
      if (node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement") {
        if (node.name === "Drawing" || node.name === "Diagram") {
          const attrs = node.attributes ?? [];
          resourceUnknown(node.name, attrs);
          const src = attrs.find((attr) => attr.name === "src");
          const from = typeof src?.value === "string" ? src.value : null;
          const to = from === null ? undefined : targets.get(from);
          if (to && src) {
            const bounds = range(node);
            const slice = quotedRange(source, src);
            if (attrs.length !== 1 || !bounds || !source.slice(bounds.from, bounds.to).endsWith("/>") || !slice) {
              block("Unsupported resource tag: use a self-closing tag with exactly one quoted src");
            } else add(slice, from!, to, jsxEncode(to, slice.quote), node);
          }
        } else for (const attr of node.attributes ?? []) {
          if (["src", "href"].includes(attr.name ?? "")) {
            const url = typeof attr.value === "string" ? attr.value : literalExpression(attr.value);
            if (url !== null) unsupportedDestination(url, "HTML/JSX destination");
          }
        }
      }
      if (node.type === "html" && typeof node.value === "string") {
        htmlDestinations(node.value).forEach((value) => unsupportedDestination(value, "HTML destination"));
      }
      if (["mdxjsEsm", "mdxFlowExpression", "mdxTextExpression"].includes(node.type)) inspectExecutable(node.data?.estree, node);
      for (const child of node.children ?? []) visit(child);
    };
    if (/\.(md|mdx)$/i.test(file.path) && !/\.excalidraw\.md$/i.test(file.path)) {
      try {
        const tree = processors[/\.mdx$/i.test(file.path) ? "mdx" : "md"].parse(source) as Node;
        collectImageDefinitions(tree);
        visit(tree);
      } catch (error) {
        block(`Cannot parse note: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else if (/\.(excalidraw|excalidraw\.md)$/i.test(file.path)) {
      try {
        const { scene } = parseDrawingFile(source, file.path);
        for (const element of scene.elements) {
          if (typeof element.link === "string") unsupportedDestination(element.link, "native drawing hyperlink");
        }
      } catch (error) {
        block(`Cannot inspect native drawing hyperlinks: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else if (/\.d2$/i.test(file.path)) {
      for (const value of d2Destinations(source)) unsupportedDestination(value, "D2 local resource destination");
    }
    patches.sort((a, b) => a.from - b.from);
    let content = source;
    for (let i = patches.length - 1; i >= 0; i--) {
      const patch = patches[i];
      if (source.slice(patch.from, patch.to) !== patch.expected || (i > 0 && patches[i - 1].to > patch.from)) {
        block("Reference source ranges overlap or changed");
        break;
      }
      content = content.slice(0, patch.from) + patch.insert + content.slice(patch.to);
    }
    if (content !== source) result.updates.push({ path: file.path, content, references });
  }
  return result;
}
