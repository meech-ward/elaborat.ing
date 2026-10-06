// The app's rendered view's markup for the parts of a note that the server's
// HTML (tools/markdown.ts) writes plainly, so the card draws them with the
// app's styles (card.css): a list item's words in a paragraph and a code
// block in a block of its own, as the rendered view's editor holds them, a
// task item's box in the bullet's place (the library's task list), a code
// block under its language (codeFence.tsx), and a table in its scrolling
// box (ReadingTable in preview-entry.tsx). DOM only, with no imports, so the
// card, its live view and its editor share it.

/** A code block's highlighted HTML, or null to keep it plain (features/rendered/codeHighlight.ts). */
export type Highlighter = (code: string, language: string) => string | null

/** A code block as the app shows one that cannot be edited there: its language over the code. */
export function codeBlock(code: string, language: string): HTMLElement {
  const block = document.createElement("div")
  block.className = "not-prose document-code"
  block.dataset.codeLanguage = language || "text"
  const label = document.createElement("div")
  label.className = "document-code-label"
  label.textContent = language || "text"
  const pre = document.createElement("pre")
  pre.tabIndex = 0
  pre.setAttribute("aria-label", `${language || "Plain text"} code`)
  const text = document.createElement("code")
  text.textContent = code
  pre.append(text)
  block.append(label, pre)
  return block
}

/**
 * Shows a code block (codeBlock) highlighted, as the app does once its
 * highlighter has loaded. The HTML is Shiki's, which escapes the code.
 */
export function highlightBlock(block: HTMLElement, highlight: Highlighter) {
  const language = block.dataset.codeLanguage ?? "text"
  const pre = block.querySelector(":scope > pre")
  if (language === "text" || !pre) return
  const html = highlight(pre.textContent ?? "", language)
  if (html === null) return
  const shown = document.createElement("div")
  shown.setAttribute("role", "group")
  shown.setAttribute("aria-label", `${language} code`)
  shown.className = "document-code-highlight"
  shown.innerHTML = html
  pre.replaceWith(shown)
}

/** The code blocks in `root` that a highlighter would change. */
export const codeToHighlight = (root: ParentNode) =>
  [...root.querySelectorAll<HTMLElement>(".document-code")].filter((block) => block.dataset.codeLanguage !== "text" && block.querySelector(":scope > pre"))

/** A table in the box the app's rendered view puts it in, which scrolls a wide one. */
export function readingTable(table: HTMLTableElement): HTMLElement {
  const box = document.createElement("div")
  box.className = "reading-table"
  box.tabIndex = 0
  box.setAttribute("role", "region")
  box.setAttribute("aria-label", "Document table")
  table.replaceWith(box)
  box.append(table)
  return box
}

const BLOCK = /^(P|UL|OL|PRE|BLOCKQUOTE|TABLE|DIV|H[1-6]|HR|FIGURE|ASIDE)$/

/** A list item's words, up to its first block (a nested list), in a paragraph. */
function itemParagraph(item: HTMLLIElement) {
  const words: ChildNode[] = []
  for (const node of item.childNodes) {
    if (node instanceof HTMLElement && BLOCK.test(node.tagName)) break
    words.push(node)
  }
  if (!words.some((node) => node.nodeType !== Node.TEXT_NODE || node.textContent?.trim())) return
  const paragraph = document.createElement("p")
  item.insertBefore(paragraph, words[0])
  paragraph.append(...words)
}

/** A task item's box in the bullet's place, named by its words, with its words beside it. */
function taskItem(item: HTMLLIElement) {
  const input = item.querySelector<HTMLInputElement>(':scope > input[type="checkbox"], :scope > p:first-child > input[type="checkbox"]')
  if (!input) return
  // The server writes a space between the box and the words.
  const after = input.nextSibling
  if (after?.nodeType === Node.TEXT_NODE) after.textContent = (after.textContent ?? "").replace(/^\s+/, "")
  input.remove()
  const words = document.createElement("div")
  words.className = "task-list-text"
  words.append(...item.childNodes)
  const first = words.firstElementChild?.tagName === "P" ? [words.firstElementChild] : [...words.childNodes].filter((node) => !(node instanceof HTMLElement && /^(UL|OL)$/.test(node.tagName)))
  const box = document.createElement("label")
  box.className = "task-list-box"
  input.className = "task-list-check"
  input.disabled = true
  input.setAttribute("aria-label", first.map((node) => node.textContent ?? "").join("").trim() || "Task")
  box.append(input)
  item.append(box, words)
}

/** Turns the server's HTML for a note, in `root`, into the app's markup for task items, code blocks and tables. */
export function readingMarkup(root: ParentNode) {
  for (const item of root.querySelectorAll<HTMLLIElement>("li")) itemParagraph(item)
  for (const item of root.querySelectorAll<HTMLLIElement>("li.task-list-item")) taskItem(item)
  for (const pre of root.querySelectorAll("pre")) {
    const code = pre.firstElementChild
    if (pre.childElementCount !== 1 || code?.tagName !== "CODE") continue
    const language = /(?:^|\s)language-(\S+)/.exec(code.className)?.[1] ?? ""
    // In a block of its own, so it keeps the space the app gives a code block above and below.
    const holder = document.createElement("div")
    holder.append(codeBlock((code.textContent ?? "").replace(/\n$/, ""), language))
    pre.replaceWith(holder)
  }
  for (const table of root.querySelectorAll("table")) {
    if (!table.parentElement?.classList.contains("reading-table")) readingTable(table)
  }
}
