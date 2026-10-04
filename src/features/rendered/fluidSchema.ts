import { Schema } from "prosemirror-model";

/** A transient editing projection, never a persisted document format. */
export const fluidSchema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      content: "inline*",
      group: "block",
      toDOM: () => ["p", 0],
      parseDOM: [{ tag: "p" }],
    },
    heading: {
      attrs: { level: { default: 1 } },
      content: "inline*",
      group: "block",
      defining: true,
      toDOM: (node) => [`h${node.attrs.level}`, 0],
      parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({
        tag: `h${level}`,
        attrs: { level },
      })),
    },
    blockquote: {
      content: "block+",
      group: "block",
      defining: true,
      toDOM: () => ["blockquote", 0],
      parseDOM: [{ tag: "blockquote" }],
    },
    bullet_list: {
      content: "list_item+",
      group: "block",
      toDOM: () => ["ul", 0],
      parseDOM: [{ tag: "ul" }],
    },
    ordered_list: {
      attrs: { order: { default: 1 } },
      content: "list_item+",
      group: "block",
      toDOM: (node) => ["ol", { start: node.attrs.order }, 0],
      parseDOM: [
        {
          tag: "ol",
          getAttrs: (node) => ({
            order: Number(node.getAttribute("start") ?? 1),
          }),
        },
      ],
    },
    list_item: {
      // A task list item's box ("- [ ] step"): true, false, or null for none.
      attrs: { checked: { default: null } },
      content: "paragraph block*",
      defining: true,
      // The editor draws a task item's box itself (fluidEditor.ts).
      toDOM: (node) =>
        node.attrs.checked === null
          ? ["li", 0]
          : ["li", { "data-checked": String(node.attrs.checked) }, 0],
      parseDOM: [
        {
          tag: "li",
          getAttrs: (node) => {
            const checked = node.getAttribute("data-checked");
            return { checked: checked === null ? null : checked === "true" };
          },
        },
      ],
    },
    horizontal_rule: {
      group: "block",
      toDOM: () => ["hr"],
      parseDOM: [{ tag: "hr" }],
    },
    hard_break: {
      inline: true,
      group: "inline",
      selectable: false,
      toDOM: () => ["br"],
      parseDOM: [{ tag: "br" }],
    },
    text: { group: "inline" },
    object: {
      group: "block",
      atom: true,
      selectable: true,
      isolating: true,
      attrs: { id: {} },
      toDOM: (node) => [
        "div",
        { "data-fluid-island": node.attrs.id, contenteditable: "false" },
      ],
    },
    inline_object: {
      inline: true,
      group: "inline",
      atom: true,
      selectable: true,
      isolating: true,
      attrs: { id: {} },
      toDOM: (node) => [
        "span",
        { "data-fluid-island": node.attrs.id, contenteditable: "false" },
      ],
    },
  },
  marks: {
    strong: {
      toDOM: () => ["strong", 0],
      parseDOM: [{ tag: "strong" }, { tag: "b" }],
    },
    em: { toDOM: () => ["em", 0], parseDOM: [{ tag: "em" }, { tag: "i" }] },
    strike: {
      toDOM: () => ["del", 0],
      parseDOM: [{ tag: "del" }, { tag: "s" }],
    },
    code: {
      excludes: "_",
      code: true,
      toDOM: () => ["code", 0],
      parseDOM: [{ tag: "code" }],
    },
    link: {
      attrs: { href: {}, title: { default: null } },
      inclusive: false,
      toDOM: (mark) => [
        "a",
        { href: mark.attrs.href, title: mark.attrs.title },
        0,
      ],
      parseDOM: [
        {
          tag: "a[href]",
          getAttrs: (node) => ({
            href: node.getAttribute("href"),
            title: node.getAttribute("title"),
          }),
        },
      ],
    },
  },
});
