/**
 * The rendered note editor of the chat card (the MCP Apps view of show_file).
 *
 * It is the app's own rendered editor, run in one page: FluidEditor (the
 * preview frame's ProseMirror editor) edits the note, and each edit it sends
 * is checked here the way the app's RenderedEditor checks it, with
 * prepareFluidTransaction turning it into an exact source patch. So only the
 * edited text changes; every other byte of the note stays as it was. Embeds,
 * code, tables and other MDX are islands the editor cannot change: embeds show
 * the drawing the server drew, and the rest shows as it is written.
 *
 * ChatCard.tsx starts it when Edit is pressed; `bun run build:chat-card`
 * builds it into the card's script with the rest of the card (main.tsx).
 */
import { COMPONENT_CATALOG } from '../features/document/componentCatalog'
import {
  fluidPositionForSourceOffset,
  fluidSourceOffsetForPosition,
  prepareFluidTransaction,
  projectFluidSource,
  type FluidProjection,
} from '../features/rendered/fluidProjection'
import type { DocumentFormat } from '../features/document'
import { FluidEditor } from '../preview/fluidEditor'

/** A drawing or diagram a note embeds, as the server reads it (tools/markdown.ts). */
export type EmbedRef = { kind: 'drawing' | 'diagram'; path: string }

export type CardEditorOptions = {
  mount: HTMLElement
  text: string
  format: DocumentFormat
  /** The drawn embed for a `<Drawing>` or `<Diagram>` tag, or null to show the tag as written. */
  embed: (ref: EmbedRef) => HTMLElement | null
  /** A short message about the last edit, or null to clear it. */
  notice: (message: string | null) => void
  /** Called after each accepted edit, with whether the note differs from where it started. */
  change: (dirty: boolean) => void
}

export type CardEditor = {
  /** The note's source once every edit in flight is checked. */
  source(): Promise<string>
  destroy(): void
}

const EMBED_TAG = /^<(Drawing|Diagram)\s+src=(?:"([^"]{1,4096})"|'([^']{1,4096})')\s*\/>$/
const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", '#10': '\n', '#13': '\r',
}

/** The embed a whole tag is, or null: the same rule as the server's parseEmbedTag. */
export function parseEmbedTag(tag: string): EmbedRef | null {
  const match = EMBED_TAG.exec(tag.trim())
  if (!match) return null
  const path = (match[2] ?? match[3] ?? '').replace(/&(amp|lt|gt|quot|apos|#39|#10|#13);/g, (_all, name: string) => ENTITIES[name])
  if (!path || path.startsWith('/') || path.split('/').some((part) => part === '' || part === '.' || part === '..')) return null
  return { kind: match[1] === 'Diagram' ? 'diagram' : 'drawing', path }
}

type Ast = { type: string; value?: string; alt?: string | null; children?: Ast[] }

const textOf = (ast: Ast): string =>
  ast.type === 'text' || ast.type === 'inlineCode' ? (ast.value ?? '') : (ast.children ?? []).map(textOf).join('')

/** An island's content: its drawing, its code or table, or its source as written. */
function renderIsland(element: HTMLElement, ast: Ast | undefined, source: string, inline: boolean, embed: CardEditorOptions['embed']) {
  const ref = parseEmbedTag(source)
  const drawn = ref ? embed(ref) : null
  if (drawn) {
    element.replaceChildren(drawn)
    return
  }
  // Compiling the note turns the island's code node into a component, so a
  // fenced block is found from its source.
  const fence = /^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n?[ \t]*\1[`~]*[ \t]*$/.exec(source)
  if (fence) {
    const pre = document.createElement('pre')
    const code = document.createElement('code')
    code.textContent = fence[2]
    pre.append(code)
    element.replaceChildren(pre)
    return
  }
  if (ast?.type === 'table') {
    const table = document.createElement('table')
    for (const [index, row] of (ast.children ?? []).entries()) {
      const tr = table.insertRow()
      for (const cell of row.children ?? []) {
        const td = document.createElement(index === 0 ? 'th' : 'td')
        td.textContent = textOf(cell)
        tr.append(td)
      }
    }
    element.replaceChildren(table)
    return
  }
  if (ast?.type === 'image') {
    element.textContent = ast.alt ?? ''
    return
  }
  const written = document.createElement(inline ? 'code' : 'pre')
  written.className = 'island-source'
  written.textContent = source
  element.replaceChildren(written)
}

type Message =
  | { kind: 'fluid-pending'; pending: boolean }
  | {
      kind: 'fluid-transaction'
      epoch: number
      operation: number
      steps: unknown[]
      before: { anchor: number; head: number }
      after: { anchor: number; head: number }
      group: string
      syntax?: Parameters<typeof prepareFluidTransaction>[3]
    }
  | { kind: 'fluid-history'; epoch: number; direction: 'undo' | 'redo' }
  | { kind: 'edit-rejected'; message: string }
  | { kind: 'rendered' }

type Point = { text: string; offset: number | null }

const SESSION = 'chat-card'

/** Shows the note in `mount` as an editable rendered document. */
export async function startCardEditor(options: CardEditorOptions): Promise<CardEditor> {
  const { mount, format, embed, notice, change } = options
  const original = options.text
  const environment = { source: original, catalog: COMPONENT_CATALOG, modules: [], key: '' }
  const project = (text: string) => projectFluidSource(text, format, { ...environment, source: text })
  let projection: FluidProjection = await project(original)
  let epoch = 0
  let operation = 0
  let revision = 0
  let group = ''
  let pending = false
  let work: Promise<void> = Promise.resolve()
  const undo: Point[] = []
  const redo: Point[] = []
  const idle: Array<() => void> = []

  const islandAst = () => {
    const byId = new Map<string, Ast>()
    for (const entry of projection.mapping.nodes) {
      if (entry.node.type.name === 'object' || entry.node.type.name === 'inline_object') byId.set(entry.node.attrs.id, entry.ast as Ast)
    }
    return byId
  }

  const fillIslands = () => {
    const asts = islandAst()
    for (const [id, element] of editor.islands) {
      if (element.dataset.filled === id) continue
      const island = projection.islands.find((entry) => entry.id === id)
      if (!island) continue
      element.dataset.filled = id
      renderIsland(element, asts.get(id), projection.text.slice(island.from, island.to), island.inline, embed)
    }
  }

  const render = (reset: boolean, selection?: { anchor: number; head: number }) => {
    editor.receive({
      kind: 'render',
      session: SESSION,
      revision,
      code: projection.code,
      slots: [],
      fluid: {
        epoch,
        operation,
        reset,
        runtimeKey: projection.runtimeKey,
        doc: projection.doc.toJSON(),
        selection,
        islands: projection.islands.map(({ id, from }) => ({ id, from })),
      },
    })
    fillIslands()
  }

  const settle = () => {
    if (pending) return
    while (idle.length) idle.shift()!()
  }

  // Undo and redo step through the note's source, like the app's Source history.
  const restore = async (from: Point[], to: Point[]) => {
    const point = from.pop()
    if (!point) return
    to.push({ text: projection.text, offset: fluidSourceOffsetForPosition(projection, editor.view.state.selection.head) })
    projection = await project(point.text)
    revision++
    epoch++
    operation = 0
    group = ''
    const position = point.offset == null ? null : fluidPositionForSourceOffset(projection, point.offset)
    render(true, position == null ? undefined : { anchor: position, head: position })
    change(projection.text !== original)
  }

  const accept = async (message: Extract<Message, { kind: 'fluid-transaction' }>) => {
    if (message.epoch !== epoch || message.operation !== operation + 1) return
    const before = projection
    try {
      const result = await prepareFluidTransaction(
        { text: before.text, revision, format },
        before,
        message.steps,
        message.syntax,
      )
      if (message.group !== group) {
        undo.push({ text: before.text, offset: fluidSourceOffsetForPosition(before, message.before.head) })
        redo.length = 0
        group = message.group
      }
      projection = result.projection
      if (result.text !== before.text) revision++
      operation = message.operation
      render(false)
      notice(null)
      change(projection.text !== original)
    } catch {
      epoch++
      operation = 0
      render(true, message.before)
      notice('That edit cannot be made here, so it was undone.')
    }
  }

  const receive = (raw: object) => {
    const message = raw as Message
    switch (message.kind) {
      case 'fluid-pending':
        pending = message.pending
        return settle()
      case 'fluid-transaction':
        work = work.then(() => accept(message))
        return
      case 'fluid-history':
        work = work.then(() => (message.direction === 'undo' ? restore(undo, redo) : restore(redo, undo)))
        return
      case 'edit-rejected':
        notice(
          message.message.includes('computed output')
            ? 'That selection includes an embed or other MDX. Change those in elaborat.ing.'
            : message.message,
        )
        return
    }
  }

  const editor = new FluidEditor(mount, () => queueMicrotask(fillIslands), receive)
  render(true)

  return {
    async source() {
      // Wait until the editor has sent every edit and each one is checked.
      for (;;) {
        await work
        if (pending) await new Promise<void>((resolve) => idle.push(resolve))
        const current = work
        await current
        if (current === work && !pending) return projection.text
      }
    },
    destroy() {
      editor.destroy()
    },
  }
}
