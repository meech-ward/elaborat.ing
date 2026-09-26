import type { AuthoringBlock, RichTextLeaf } from "../document/structural";

type Node = {
  type: string;
  value?: string;
  children?: Node[];
  position?: { start: { offset?: number }; end: { offset?: number } };
};
export type BlockBoundary = { id: string; offset: number };
export type BlockMap = {
  blocks: AuthoringBlock[];
  boundaries: BlockBoundary[];
  richLeaves: RichTextLeaf[];
};

/** Only parser-proven, ordinary text blocks get structural authority. */
export function collectBlocks(tree: unknown, source: string): BlockMap {
  const root = tree as Node;
  const blocks: AuthoringBlock[] = [];
  const richLeaves: RichTextLeaf[] = [];
  const boundaries: BlockBoundary[] = [{ id: "start", offset: 0 }];
  const children = root.children ?? [];
  function walk(node: Node, after: number, owner?: Node) {
    if (node.type === "list") {
      for (const item of node.children ?? []) {
        if ((item.children?.length ?? 0) === 0) add(item, after, item);
        else if (item.children?.length === 1)
          walk(item.children[0], after, item);
      }
    } else if (node.type === "blockquote") {
      if (!node.children?.length) add(node, after, node);
      else if (node.children.length === 1) walk(node.children[0], after, node);
    } else if (node.type === "paragraph" || node.type === "heading") {
      if ((node.children ?? []).every((child) => child.type === "text"))
        add(node, after, owner);
    }
  }
  function add(node: Node, after: number, owner?: Node) {
    const outer = owner ?? node;
    const from = outer.position?.start.offset;
    let to = outer.position?.end.offset;
    if (from == null || to == null) return;
    while (source[to] === " " || source[to] === "\t") to++;
    const raw = source.slice(from, to);
    const kind =
      owner?.type === "listItem"
        ? "list"
        : owner?.type === "blockquote"
          ? "quote"
          : node.type === "heading"
            ? "heading"
            : "paragraph";
    if (kind !== "paragraph" && raw.includes("\n")) return;
    const marker =
      kind === "list"
        ? /^(?:[-+*]|\d+[.)])\s*/.exec(raw)
        : kind === "quote"
          ? /^>\s*/.exec(raw)
          : kind === "heading"
            ? /^#{1,6}\s*/.exec(raw)
            : null;
    const prefix = marker?.[0] ?? "";
    const contentFrom = from + prefix.length;
    const value = (node.children ?? [])
      .map((child) => child.value ?? "")
      .join("");
    blocks.push({
      id: `block:${from}`,
      from,
      to,
      contentFrom,
      contentTo: to,
      value,
      kind,
      prefix,
      after,
    });
  }
  let previousEnd = 0;
  for (const node of children) {
    const from = node.position?.start.offset;
    const to = node.position?.end.offset;
    if (from == null || to == null) continue;
    if (
      /^\s*$/.test(source.slice(previousEnd, from)) &&
      (source.slice(previousEnd, from).match(/\n/g)?.length ?? 0) >= 4
    ) {
      gap(previousEnd + 2);
    }
    walk(node, to);
    if (
      (node.type === "paragraph" || node.type === "heading") &&
      (node.children ?? []).some((child) => child.type !== "text")
    ) {
      const safe = (entry: Node): boolean =>
        ["text", "emphasis", "strong", "delete", "inlineCode"].includes(
          entry.type,
        ) && (entry.children ?? []).every(safe);
      if ((node.children ?? []).every(safe)) {
        const collect = (entry: Node, open: string, close: string) => {
          const start = entry.position?.start.offset;
          const end = entry.position?.end.offset;
          if (start == null || end == null) return;
          if (entry.type === "text")
            richLeaves.push({
              from: start,
              to: end,
              expected: source.slice(start, end),
              blockFrom: from,
              blockTo: to,
              open,
              close,
            });
          else if (entry.children?.length) {
            const first = entry.children[0].position?.start.offset;
            const last = entry.children.at(-1)?.position?.end.offset;
            if (first == null || last == null) return;
            for (const child of entry.children)
              collect(
                child,
                open + source.slice(start, first),
                source.slice(last, end) + close,
              );
          }
        };
        for (const child of node.children ?? []) collect(child, "", "");
        richLeaves.push({
          from: to,
          to,
          expected: "",
          blockFrom: from,
          blockTo: to,
          open: "",
          close: "",
        });
      }
    }
    boundaries.push({ id: `after:${to}`, offset: to });
    previousEnd = to;
  }
  if (!children.length && /^\s*$/.test(source)) gap(source.length);
  else if (
    /^\s*$/.test(source.slice(previousEnd)) &&
    source.slice(previousEnd).includes("\n\n")
  )
    gap(source.length);
  function gap(offset: number) {
    blocks.push({
      id: `gap:${offset}`,
      from: offset,
      to: offset,
      contentFrom: offset,
      contentTo: offset,
      value: "",
      kind: "gap",
      prefix: "",
      after: offset,
    });
  }
  return { blocks, boundaries, richLeaves };
}
