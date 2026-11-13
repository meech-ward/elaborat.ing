import { expect, test } from 'bun:test'
import { EditorState, TextSelection, type Command, type Transaction } from 'prosemirror-state'
import { baseKeymap } from 'prosemirror-commands'
import { Transform } from 'prosemirror-transform'
import { keepingEmptyParagraphs } from './fluidCommands'
import { fluidPositionForSourceOffset, fluidSourceOffsetForPosition, prepareFluidTransaction, projectFluidSource } from './fluidProjection'

const paragraph = 'Following paragraph.'
const drawing = '<Drawing src="sketch.excalidraw" />'

const fixtures = [
  { name: 'Drawing JSX', object: drawing, format: 'mdx' },
  { name: 'multi-line Drawing JSX', object: '<Drawing\n  src="sketch.excalidraw"\n/>', format: 'mdx' },
  { name: 'Diagram JSX', object: '<Diagram src="flow.d2" />', format: 'mdx' },
  { name: 'Markdown code fence', object: '```js\nconst keep = "exact";\n```', format: 'md' },
  { name: 'Markdown table', object: '| Keep |\n| --- |\n| exact |', format: 'md' },
] as const

for (const fixture of fixtures) {
  for (const side of ['before', 'after'] as const) {
    const note = side === 'after' ? `${fixture.object}\n\n\n${paragraph}\n` : `${paragraph}\n\n\n${fixture.object}\n`
    test(`${fixture.name}: one extra Source newline ${side} a protected block is an editable empty line`, async () => {
      const projection = await projectFluidSource(note, fixture.format)
      expect(projection.doc.content.content.map(node => node.type.name)).toEqual(side === 'after' ? ['object', 'paragraph', 'paragraph'] : ['paragraph', 'paragraph', 'object'])
      const empty = projection.mapping.roots[1]
      const position = empty.pos + 1
      expect(fluidPositionForSourceOffset(projection, empty.from)).toBe(position)
      expect(fluidSourceOffsetForPosition(projection, position)).toBe(empty.from)
      const typed = new Transform(projection.doc).insert(position, projection.doc.type.schema.text('Typed here.'))
      const next = await prepareFluidTransaction({ text: note, format: fixture.format, revision: 0 }, projection, typed.steps.map(step => step.toJSON()))
      expect(next.text).toBe(note.replace('\n\n\n', '\n\nTyped here.\n\n'))
      expect(next.projection.doc.eq(typed.doc)).toBe(true)
      expect(next.projection.islands.map(island => island.id)).toEqual(projection.islands.map(island => island.id))
      expect(next.text).toContain(fixture.object)
    })

    test(`${fixture.name}: Backspace removes only the ${side} empty line and Enter keeps its caret writable`, async () => {
      const projection = await projectFluidSource(note, fixture.format)
      const position = projection.mapping.roots[1].pos + 1
      const state = EditorState.create({ doc: projection.doc, selection: TextSelection.create(projection.doc, position) })
      const run = (command: Command) => {
        let made: Transaction | undefined
        expect(command(state, tr => { made = tr })).toBe(true)
        return made
      }
      // The existing one-empty-paragraph convention still holds: another Enter
      // stays on this line, where the next typed text can be written exactly.
      expect(run(keepingEmptyParagraphs(baseKeymap.Enter))).toBeUndefined()
      const deletion = run(baseKeymap.Backspace)!
      const next = await prepareFluidTransaction({ text: note, format: fixture.format, revision: 0 }, projection, deletion.steps.map(step => step.toJSON()))
      expect(next.text).toBe(note.replace('\n\n\n', '\n\n'))
      expect(next.projection.doc.eq(deletion.doc)).toBe(true)
      expect(next.projection.islands.map(island => island.id)).toEqual(projection.islands.map(island => island.id))
    })
  }
}

test('ordinary prose and unrendered ESM/comments retain the existing four-newline convention', async () => {
  for (const first of ['First paragraph.', 'export const kept = 7;', '{/* preserve this comment */}']) {
    const three = await projectFluidSource(`${first}\n\n\n${paragraph}\n`, 'mdx')
    const four = await projectFluidSource(`${first}\n\n\n\n${paragraph}\n`, 'mdx')
    expect(three.mapping.roots.filter(root => root.node.type.name === 'paragraph' && !root.node.content.size)).toHaveLength(0)
    expect(four.mapping.roots.filter(root => root.node.type.name === 'paragraph' && !root.node.content.size)).toHaveLength(1)
  }
})

test('a three-newline gap beside unrendered source never gains a new editable paragraph even next to a drawing', async () => {
  for (const retained of ['export const kept = 7;', '{/* preserve this comment */}']) {
    const text = `${drawing}\n\n\n${retained}\n\n\n\n${paragraph}\n`
    const projection = await projectFluidSource(text, 'mdx')
    const empty = projection.mapping.roots.filter(root => root.node.type.name === 'paragraph' && !root.node.content.size)
    expect(empty).toHaveLength(1)
    expect(empty[0].from).toBeGreaterThan(text.indexOf(retained) + retained.length)
    expect(projection.islands.map(island => text.slice(island.from, island.to))).toEqual([drawing])
  }
})

test('two newlines keep normal drawing spacing and four or more retain one existing empty paragraph', async () => {
  for (const count of [2, 3, 4, 5, 6]) {
    const projection = await projectFluidSource(`${drawing}${'\n'.repeat(count)}${paragraph}\n`, 'mdx')
    expect(projection.doc.childCount).toBe(count === 2 ? 2 : 3)
    expect(projection.islands).toHaveLength(1)
  }
})

test('a compact CRLF gap owns only the final line break when it is typed into or removed', async () => {
  const note = `${drawing}\r\n\r\n\r\n${paragraph}\r\n`
  const projection = await projectFluidSource(note, 'mdx')
  const position = projection.mapping.roots[1].pos + 1
  const tr = new Transform(projection.doc).insert(position, projection.doc.type.schema.text('Typed.'))
  const next = await prepareFluidTransaction({ text: note, format: 'mdx', revision: 0 }, projection, tr.steps.map(step => step.toJSON()))
  expect(next.text).toBe(`${drawing}\r\n\r\nTyped.\n\n${paragraph}\r\n`)
  const state = EditorState.create({ doc: projection.doc, selection: TextSelection.create(projection.doc, position) })
  let deletion: Transaction | undefined
  baseKeymap.Backspace(state, tr => { deletion = tr })
  const removed = await prepareFluidTransaction({ text: note, format: 'mdx', revision: 0 }, projection, deletion!.steps.map(step => step.toJSON()))
  expect(removed.text).toBe(`${drawing}\r\n\r\n${paragraph}\r\n`)
})
