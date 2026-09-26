import {
  encodeProseText,
  type DocumentSnapshot,
  type SourcePatch,
} from "./index";

/** Parent-owned parser positions. Never accepted from an iframe request. */
export type AuthoringBlock = {
  id: string;
  from: number;
  to: number;
  contentFrom: number;
  contentTo: number;
  value: string;
  kind: "paragraph" | "heading" | "list" | "quote" | "gap";
  prefix: string;
  after: number;
};
export type BlockIntent = {
  block: string;
  action: "commit" | "enter" | "shortcut";
  value: string;
  caret: number;
};
export type StructuralResult = { patch: SourcePatch; focus: number };
export type RichTextLeaf = {
  from: number;
  to: number;
  expected: string;
  blockFrom: number;
  blockTo: number;
  open: string;
  close: string;
};

/** Split one parser-owned rich paragraph, copying its original inline delimiters. */
export function splitRichLeaf(
  document: DocumentSnapshot,
  revision: number,
  leaves: readonly RichTextLeaf[],
  intent: {
    from: number;
    to: number;
    expected: string;
    value: string;
    caret: number;
  },
): StructuralResult {
  if (revision !== document.revision)
    throw new Error("Rejected stale paragraph split.");
  const leaf = leaves.find(
    (entry) =>
      entry.from === intent.from &&
      entry.to === intent.to &&
      entry.expected === intent.expected,
  );
  if (!leaf)
    throw new Error("This output is source-only for structural editing.");
  if (intent.caret < 0 || intent.caret > intent.value.length)
    throw new Error("Rejected invalid paragraph caret.");
  const before = document.text.slice(leaf.blockFrom, leaf.from);
  const after = document.text.slice(leaf.to, leaf.blockTo);
  const leftText = encodeProseText(
    intent.value.slice(0, intent.caret),
    document.format,
  );
  const rightText = encodeProseText(
    intent.value.slice(intent.caret),
    document.format,
  );
  const trailing = leaf.close ? (/\s+$/.exec(leftText)?.[0] ?? "") : "";
  const leading = leaf.open ? (/^\s+/.exec(rightText)?.[0] ?? "") : "";
  const left =
    leftText === "" && leaf.open && before.endsWith(leaf.open)
      ? before.slice(0, -leaf.open.length)
      : before +
        leftText.slice(0, leftText.length - trailing.length) +
        leaf.close +
        trailing;
  const right =
    intent.caret === intent.value.length && after === leaf.close
      ? ""
      : leading + leaf.open + rightText.slice(leading.length) + after;
  return {
    patch: {
      from: leaf.blockFrom,
      to: leaf.blockTo,
      expected: document.text.slice(leaf.blockFrom, leaf.blockTo),
      insert: left + "\n\n" + right,
    },
    focus:
      leaf.blockFrom +
      left.length +
      2 +
      (right ? leading.length + leaf.open.length : 0),
  };
}

export function editBlock(
  document: DocumentSnapshot,
  revision: number,
  blocks: readonly AuthoringBlock[],
  intent: BlockIntent,
): StructuralResult {
  if (revision !== document.revision)
    throw new Error("Rejected stale structural edit.");
  const block = blocks.find((entry) => entry.id === intent.block);
  if (!block)
    throw new Error("Rejected edit outside an ordinary source block.");
  if (
    !Number.isInteger(intent.caret) ||
    intent.caret < 0 ||
    intent.caret > intent.value.length
  )
    throw new Error("Rejected invalid block caret.");
  const encode = (value: string) => encodeProseText(value, document.format);
  const expected = document.text.slice(block.from, block.to);
  let insert = block.prefix + encode(intent.value);
  let focus =
    block.from +
    block.prefix.length +
    encode(intent.value.slice(0, intent.caret)).length;
  if (intent.action === "shortcut") {
    const marker = /^(#{1,6} |[-+*] |1\. |> )(.*)$/s.exec(intent.value);
    if (marker && (block.kind === "paragraph" || block.kind === "gap")) {
      insert = marker[1] + encodeInlineInput(marker[2], document.format);
    } else {
      insert = block.prefix + encodeInlineInput(intent.value, document.format);
    }
    focus = block.from + insert.length;
  }
  if (intent.action === "enter") {
    const marker = /^(#{1,6} |[-+*] |1\. |> )(.*)$/s.exec(intent.value);
    if (
      marker &&
      intent.caret >= marker[1].length &&
      (block.kind === "paragraph" || block.kind === "gap")
    ) {
      const kind = marker[1].startsWith("#")
        ? "heading"
        : marker[1].startsWith(">")
          ? "quote"
          : "list";
      return editBlock(
        document,
        revision,
        [{ ...block, kind, prefix: marker[1] }],
        { ...intent, value: marker[2], caret: intent.caret - marker[1].length },
      );
    }
    const left = encodeInlineInput(
      intent.value.slice(0, intent.caret),
      document.format,
    );
    const right = encodeInlineInput(
      intent.value.slice(intent.caret),
      document.format,
    );
    if (
      intent.value === "---" &&
      (block.kind === "paragraph" || block.kind === "gap")
    ) {
      insert = "---\n\n";
      focus = block.from + insert.length;
    } else if (block.kind === "list" && intent.value === "") {
      insert = "\n\n";
      focus = block.from + insert.length;
    } else {
      const nextPrefix =
        block.kind === "list"
          ? block.prefix.replace(/^\d+/, (number) => String(Number(number) + 1))
          : "";
      const separator = block.kind === "list" ? "\n" : "\n\n";
      insert = block.prefix + left + separator + nextPrefix + right;
      focus =
        block.from +
        block.prefix.length +
        left.length +
        separator.length +
        nextPrefix.length;
    }
  }
  return { patch: { from: block.from, to: block.to, expected, insert }, focus };
}

/** Literal prose is the fallback; only explicitly closed inline pairs earn syntax. */
export function encodeInlineInput(
  value: string,
  format: DocumentSnapshot["format"],
): string {
  const encode = (text: string) => encodeProseText(text, format);
  let result = "";
  let plain = "";
  const flush = () => {
    result += encode(plain);
    plain = "";
  };
  for (let index = 0; index < value.length;) {
    if (value[index] === "\\" && index + 1 < value.length) {
      // A deliberately escaped marker remains visibly literal.
      plain += value[index + 1];
      index += 2;
      continue;
    }
    const delimiter = ["`", "**", "__", "~~", "*", "_"].find((mark) =>
      value.startsWith(mark, index),
    );
    if (delimiter) {
      let end = value.indexOf(delimiter, index + delimiter.length);
      while (end >= 0 && value[end - 1] === "\\")
        end = value.indexOf(delimiter, end + delimiter.length);
      const inner = end < 0 ? "" : value.slice(index + delimiter.length, end);
      if (inner && !/\n/.test(inner) && !/^\s|\s$/.test(inner)) {
        flush();
        result +=
          delimiter + (delimiter === "`" ? inner : encode(inner)) + delimiter;
        index = end + delimiter.length;
        continue;
      }
    }
    plain += value[index++];
  }
  flush();
  return result;
}
