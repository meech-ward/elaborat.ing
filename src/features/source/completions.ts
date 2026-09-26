export interface SourceCompletion {
  label: string;
  detail: string;
  insertText: string;
  from: number;
  to: number;
  snippet: boolean;
  kind: "component" | "property" | "value" | "file" | "node" | "template";
}

export interface CompletionRequest {
  text: string;
  offset: number;
  language: string;
  workspacePaths?: readonly string[];
  componentCatalog?: readonly ComponentDefinition[];
}

/** Context assistance only; the document compiler remains authoritative. */
export function completeSource(request: CompletionRequest): SourceCompletion[] {
  if (request.offset < 0 || request.offset > request.text.length) return [];
  if (request.language === "d2") return completeD2(request);
  if (request.language !== "mdx") return [];
  const context = maskMdxCode(request.text, request.offset);
  return context === null ? [] : completeMdx(request, context);
}

/** Snippet escaping is distinct from JSX literal escaping. */
const snippetLiteral = (value: string) => value.replace(/[\\$}]/g, "\\$&");
const attributeLiteral = (value: string, quote: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(quote === '"' ? /"/g : /'/g, quote === '"' ? "&quot;" : "&#39;");

// A bounded lexical context check, not an MDX parser. Closed code/comments
// are skipped; an unfinished one suppresses suggestions until it is closed.
function maskMdxCode(text: string, offset: number): string | null {
  let masked = text;
  const start = /<!--|\{\/\*|^[ \t]{0,3}(`{3,}|~{3,})[^\n]*|`+/gm;
  let match: RegExpExecArray | null;
  while ((match = start.exec(text)) && match.index < offset) {
    const token = match[0];
    let end: number;
    if (token === "<!--" || token === "{/*") {
      const close = token === "<!--" ? "-->" : "*/}";
      const at = text.indexOf(close, start.lastIndex);
      end = at < 0 ? text.length + 1 : at + close.length;
    } else if (match[1]) {
      const fence = match[1];
      const closing = new RegExp(
        `^[ \\t]{0,3}${fence[0]}{${fence.length},}[ \\t]*$`,
        "gm",
      );
      closing.lastIndex = start.lastIndex;
      const close = closing.exec(text);
      end = close ? closing.lastIndex : text.length + 1;
    } else {
      const at = text.indexOf(token, start.lastIndex);
      end = at < 0 ? text.length + 1 : at + token.length;
    }
    if (offset < end) return null;
    masked =
      masked.slice(0, match.index) +
      masked.slice(match.index, end).replace(/[^\n]/g, " ") +
      masked.slice(end);
    start.lastIndex = end;
  }
  return masked;
}

function completeMdx(
  { text, offset, workspacePaths = [], componentCatalog = COMPONENT_CATALOG }: CompletionRequest,
  context: string,
): SourceCompletion[] {
  // Find an unclosed opening tag without treating > inside quoted attributes
  // or JS expressions as the end of the tag.
  let tag = -1,
    quote = "",
    braces = 0;
  for (let i = 0; i < offset; i++) {
    const c = context[i];
    if (tag < 0) {
      if (c === "<" && /^[A-Za-z]?$/.test(context[i + 1] ?? "")) tag = i;
    } else if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "{") braces++;
    else if (c === "}") braces = Math.max(0, braces - 1);
    else if (c === ">" && !braces) tag = -1;
  }
  const before = text.slice(0, offset);
  if (tag < 0) {
    // Ctrl+Space at a blank block also makes insertion discoverable.
    if (!/(?:^|\n)[ \t]*$/.test(before)) return [];
    return componentCatalog.map((component) => ({
      label: component.name,
      detail: component.description,
      insertText: component.snippet,
      snippet: true,
      from: offset,
      to: offset,
      kind: "component",
    }));
  }
  const fragment = text.slice(tag + 1, offset);
  const name = /^([A-Za-z][\w.]*)?([\s\S]*)$/.exec(fragment);
  if (!name) return [];
  if (!name[2]) {
    const nameEnd = offset + (/^[\w.]*/.exec(text.slice(offset))?.[0].length ?? 0);
    // Monaco may insert the matching > as soon as < is typed. The complete
    // component snippet owns that delimiter, otherwise acceptance leaves />>.
    const to = nameEnd + (text[nameEnd] === '>' ? 1 : 0);
    return componentCatalog.filter((component) =>
      component.name.startsWith(name[1] ?? ""),
    ).map((component) => ({
      label: component.name,
      detail: component.description,
      insertText: component.snippet,
      snippet: true,
      from: tag,
      to,
      kind: "component",
    }));
  }
  const component = getComponentDefinition(name[1], componentCatalog);
  if (!component) return [];
  const attrs = name[2];
  const value = /([\w-]+)\s*=\s*(["'])([^"']*)$/.exec(attrs);
  if (value && quote) {
    const prop = component.props.find((p) => p.name === value[1]);
    if (!prop) return [];
    const from = offset - value[3].length;
    const endQuote = text.indexOf(value[2], offset);
    const lineEnd = text.indexOf("\n", offset);
    const to =
      endQuote >= 0 && (lineEnd < 0 || endQuote < lineEnd) ? endQuote : offset;
    const choices = prop.resourceKind
      ? [...new Set(workspacePaths)]
          .filter((path) =>
            prop.resourceKind === "drawing"
              ? /\.excalidraw(?:\.md)?$/i.test(path)
              : /\.d2$/i.test(path),
          )
          .sort()
      : (prop.choices ?? []);
    return choices
      .filter((choice) => choice.startsWith(value[3]))
      .map((choice) => ({
        label: choice,
        detail: prop.description,
        insertText: attributeLiteral(choice, value[2]),
        snippet: false,
        from,
        to,
        kind: prop.resourceKind ? "file" : "value",
      }));
  }
  if (quote || braces) return [];
  const partial = /(?:^|\s)([\w-]*)$/.exec(attrs);
  if (!partial) return [];
  const used = new Set(
    [...attrs.matchAll(/([\w-]+)\s*=/g)].map((match) => match[1]),
  );
  const from = offset - partial[1].length;
  const to = offset + (/^[\w-]*/.exec(text.slice(offset))?.[0].length ?? 0);
  return component.props
    .filter((prop) => !used.has(prop.name) && prop.name.startsWith(partial[1]))
    .map((prop) => {
      const defaultValue = snippetLiteral(
        attributeLiteral(String(prop.defaultValue), '"'),
      );
      const placeholder = prop.choices
        ? "${1|" + prop.choices.map(choice => attributeLiteral(choice, '"').replace(/[\\,|]/g, '\\$&')).join(",") + "|}"
        : "${1:" + defaultValue + "}";
      const insertText = /^\s*=/.test(text.slice(to))
        ? prop.name
        : prop.name +
          (prop.type !== "string"
            ? "={" + placeholder + "}"
            : '="' + placeholder + '"');
      return {
        label: prop.name,
        detail: prop.description,
        insertText,
        from,
        to,
        snippet: true,
        kind: "property",
      };
    });
}
import {
  COMPONENT_CATALOG,
  getComponentDefinition,
  type ComponentDefinition,
} from "../document/componentCatalog";
import { completeD2 } from "./d2Completions";
