import { D2_SHAPES } from "./d2Language";
import type { CompletionRequest, SourceCompletion } from "./completions";

const VALUES: Record<string, readonly string[]> = {
  shape: D2_SHAPES,
  direction: ["right", "down", "left", "up"],
  opacity: ["0", "0.5", "1"],
  "stroke-width": ["1", "2", "3"],
  "font-size": ["16", "20", "24"],
  fill: ["transparent", "white", "lightblue"],
  stroke: ["black", "gray", "blue"],
  "font-color": ["black", "white"],
  "text-transform": ["none", "uppercase", "lowercase", "title"],
  shadow: ["true", "false"],
  multiple: ["true", "false"],
  "double-border": ["true", "false"],
  animated: ["true", "false"],
  bold: ["true", "false"],
  italic: ["true", "false"],
  underline: ["true", "false"],
};
const STYLE_KEYS = [
  "fill",
  "stroke",
  "stroke-width",
  "stroke-dash",
  "opacity",
  "font-size",
  "font-color",
  "border-radius",
  "shadow",
  "multiple",
  "double-border",
  "animated",
  "bold",
  "italic",
  "underline",
  "text-transform",
];
const CORE_KEYS = [
  "shape",
  "label",
  "direction",
  "width",
  "height",
  "style",
  "tooltip",
  "link",
  "icon",
  "near",
  "grid-rows",
  "grid-columns",
  "grid-gap",
];
const RESERVED = new Set([
  ...CORE_KEYS,
  ...STYLE_KEYS,
  "classes",
  "class",
  "vars",
  "layers",
  "scenarios",
  "steps",
  "constraint",
  "source-arrowhead",
  "target-arrowhead",
]);

export const D2_TEMPLATES = [
  {
    label: "Flow diagram",
    detail: "Start, decision and result",
    snippet:
      "direction: down\nstart: ${1:Start}\ndecision: ${2:Ready?} {\n  shape: diamond\n}\nfinish: ${3:Done}\nstart -> decision\ndecision -> finish: Yes\n$0",
  },
  {
    label: "ERD diagram",
    detail: "Related SQL tables",
    snippet:
      "users: {\n  shape: sql_table\n  id: int {constraint: primary_key}\n  name: ${1:text}\n}\norders: {\n  shape: sql_table\n  id: int {constraint: primary_key}\n  user_id: int {constraint: foreign_key}\n}\norders.user_id -> users.id\n$0",
  },
  {
    label: "Cloud architecture",
    detail: "Client, service and database",
    snippet:
      "direction: right\nclient: ${1:Client}\ncloud: ${2:Cloud} {\n  shape: cloud\n  api: ${3:API}\n  database: Database {\n    shape: cylinder\n  }\n  api -> database\n}\nclient -> cloud.api\n$0",
  },
] as const;

interface Scope {
  path: string[];
  properties: boolean;
  style: boolean;
}
const ROOT_SCOPE: Scope = { path: [], properties: false, style: false };
const NODE = /^[A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)*$/;
const CONNECTION = /<->|->|<-|--/;

/** Ordinary unquoted keys and nested maps only. This is assistance, not a
 * replacement for D2 parsing: quoted keys, imports, globs and layers are not
 * inferred as node declarations. Strings/comments never mint fake nodes. */
function scanD2(text: string, at: number) {
  const nodes = new Set<string>();
  const stack: Scope[] = [ROOT_SCOPE];
  let current = ROOT_SCOPE,
    statement = "",
    quote = "",
    comment = false;
  let atScope = ROOT_SCOPE,
    atStatement = "",
    suppressed = false;
  const resolve = (key: string, scope: Scope) => {
    const parts = key.split("."),
      prefix = [...scope.path];
    while (parts[0] === "_") {
      parts.shift();
      prefix.pop();
    }
    return [...prefix, ...parts].join(".");
  };
  const record = (statement: string) => {
    const head = statement.split(":")[0].trim();
    const endpoints = head.split(CONNECTION).map((part) => part.trim());
    for (const key of endpoints) {
      if (
        !current.properties &&
        NODE.test(key) &&
        !key.split(".").some((part) => RESERVED.has(part))
      )
        nodes.add(resolve(key, current));
    }
    return head;
  };
  for (let i = 0; i <= text.length; i++) {
    if (i === at) {
      atScope = current;
      atStatement = statement;
      suppressed = !!quote || comment;
    }
    const c = text[i];
    if (comment) {
      if (c !== "\n" && c !== undefined) continue;
      comment = false;
    }
    if (quote) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === quote) quote = "";
      continue;
    }
    if (c === "#") {
      comment = true;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      statement += '""';
      continue;
    }
    if (c === "{") {
      const head = record(statement);
      const property =
        current.properties ||
        !NODE.test(head) ||
        head.split(".").some((part) => RESERVED.has(part));
      const path = property ? current.path : resolve(head, current).split(".");
      current = {
        path,
        properties: property,
        style: head === "style" || head.endsWith(".style"),
      };
      stack.push(current);
      statement = "";
    } else if (c === "}" || c === "\n" || c === ";" || c === undefined) {
      record(statement);
      statement = "";
      if (c === "}") {
        stack.pop();
        current = stack.at(-1) ?? ROOT_SCOPE;
      }
    } else statement += c;
  }
  return {
    nodes: [...nodes],
    scope: atScope,
    statement: atStatement,
    suppressed,
  };
}

export function completeD2({
  text,
  offset,
}: CompletionRequest): SourceCompletion[] {
  const context = scanD2(text, offset);
  if (context.suppressed || /\|/.test(context.statement)) return [];
  const statement = context.statement;
  const connection = /(?:<->|->|<-|--)\s*([\w.-]*)$/.exec(statement);
  if (connection && !context.scope.properties) {
    const prefix = connection[1];
    const from = offset - prefix.length;
    const to = offset + (/^[\w.-]*/.exec(text.slice(offset))?.[0].length ?? 0);
    return context.nodes
      .map((node) => {
        const path = node.split(".");
        let shared = 0;
        while (
          shared < context.scope.path.length &&
          path[shared] === context.scope.path[shared]
        )
          shared++;
        return [
          ...Array<string>(context.scope.path.length - shared).fill("_"),
          ...path.slice(shared),
        ].join(".");
      })
      .filter((name) => name && name.startsWith(prefix))
      .sort()
      .map((name) => ({
        label: name,
        detail: "Existing node (relative to this map)",
        insertText: name,
        from,
        to,
        snippet: false,
        kind: "node",
      }));
  }
  const value = /(?:^|\.)([\w-]+)\s*:\s*([\w.-]*)$/.exec(statement.trim());
  if (value) {
    const from = offset - value[2].length;
    const to = offset + (/^[\w.-]*/.exec(text.slice(offset))?.[0].length ?? 0);
    return (Object.hasOwn(VALUES, value[1]) ? VALUES[value[1]] : [])
      .filter((item) => item.startsWith(value[2]))
      .map((item) => ({
        label: item,
        detail: `D2 ${value[1]} value`,
        insertText: item,
        from,
        to,
        snippet: false,
        kind: "value",
      }));
  }
  const key = /^\s*([\w.-]*)$/.exec(statement);
  if (!key || (context.scope.properties && !context.scope.style)) return [];
  const prefix = key[1].split(".").at(-1) ?? "";
  const from = offset - prefix.length;
  const to = offset + (/^[\w-]*/.exec(text.slice(offset))?.[0].length ?? 0);
  const style = context.scope.style || key[1].includes("style.");
  const items: SourceCompletion[] = (style ? STYLE_KEYS : CORE_KEYS)
    .filter((name) => name.startsWith(prefix))
    .map((name) => {
      const value =
        VALUES[name]?.[0] ??
        (name === "width" || name === "height" ? "200" : "");
      const insertText = /^\s*:/.test(text.slice(to))
        ? name
        : name === "style"
          ? "style: {\n  $0\n}"
          : name + ": ${1:" + value + "}";
      return {
        label: name,
        detail: `D2 ${style ? "style " : ""}property`,
        insertText,
        from,
        to,
        snippet: true,
        kind: "property",
      };
    });
  if (!context.scope.path.length && !style && !key[1].includes(".")) {
    items.push(
      ...D2_TEMPLATES.filter((template) =>
        template.label.toLowerCase().startsWith(prefix.toLowerCase()),
      ).map((template): SourceCompletion => ({
        label: template.label,
        detail: template.detail,
        insertText: template.snippet,
        from,
        to,
        snippet: true,
        kind: "template",
      })),
    );
  }
  return items;
}
