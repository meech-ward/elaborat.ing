import { assert, assertEquals, assertFalse, assertStringIncludes, assertThrows } from 'jsr:@std/assert@1.0.19'
import LZString from 'npm:lz-string@1.5.0'

import { drawingSvg, MAX_ELEMENTS, parseDrawing } from './drawingSvg.ts'

// The server-side drawing of an Excalidraw scene for the file view.

const base = {
  angle: 0,
  strokeColor: '#1e1e1e',
  backgroundColor: 'transparent',
  fillStyle: 'solid',
  strokeWidth: 2,
  strokeStyle: 'solid',
  roughness: 1,
  opacity: 100,
  seed: 7,
  roundness: null,
}

const SIMPLE_SCENE = {
  type: 'excalidraw',
  version: 2,
  elements: [
    { ...base, id: 'box', type: 'rectangle', x: 0, y: 0, width: 120, height: 60, backgroundColor: '#a5d8ff', roundness: { type: 3 } },
    { ...base, id: 'oval', type: 'ellipse', x: 200, y: 0, width: 100, height: 60 },
    { ...base, id: 'link', type: 'arrow', x: 120, y: 30, width: 80, height: 0, points: [[0, 0], [80, 0]], startArrowhead: null, endArrowhead: 'arrow' },
    { ...base, id: 'label', type: 'text', x: 10, y: 18, width: 100, height: 25, text: 'Hi <b> & "you"\nline two', fontSize: 20, fontFamily: 5, textAlign: 'center', lineHeight: 1.25 },
    { ...base, id: 'gone', type: 'rectangle', x: 5000, y: 5000, width: 10, height: 10, isDeleted: true },
  ],
}

const svgOf = (scene: { elements: unknown[] }) => {
  const result = drawingSvg(parseDrawing(JSON.stringify(scene)))
  assert('svg' in result, JSON.stringify(result))
  return result.svg
}

Deno.test('a scene with a rectangle, an ellipse, an arrow and text draws as one SVG', () => {
  const svg = svgOf(SIMPLE_SCENE)
  assert(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="-10 -10 320 80" width="320" height="80">'), svg.slice(0, 120))
  assert(svg.endsWith('</svg>'))
  // One group per live element; the deleted one is left out.
  assertEquals(svg.match(/<g /g)?.length, 4)
  assertFalse(svg.includes('5000'))
  // The rectangle's solid fill and everyone's ink.
  assertStringIncludes(svg, 'fill="#a5d8ff"')
  assertStringIncludes(svg, 'stroke="#1e1e1e"')
  // The arrow: its body and the two strokes of its head.
  const arrow = svg.split('<g ')[3]
  assertStringIncludes(arrow, 'translate(120 30)')
  assert((arrow.match(/<path /g)?.length ?? 0) >= 3, arrow)
  // Text: one line each, centred, with the file's text escaped.
  assertStringIncludes(svg, '>Hi &lt;b&gt; &amp; "you"</text>')
  assertStringIncludes(svg, '>line two</text>')
  assertStringIncludes(svg, 'text-anchor="middle"')
  assertStringIncludes(svg, 'x="50" y="12.5"')
  assertStringIncludes(svg, 'y="37.5"')
  // Drawn with the element's seed, so the same scene draws the same way.
  assertEquals(svgOf(SIMPLE_SCENE), svg)
})

Deno.test('the SVG takes nothing from the file that could run or load', () => {
  const svg = svgOf({
    elements: [
      { ...base, id: 'a', type: 'rectangle', x: 0, y: 0, width: 50, height: 50, strokeColor: 'url(https://example.com/x)', backgroundColor: '"><script>alert(1)</script>' },
      { ...base, id: 'b', type: 'text', x: 0, y: 60, width: 50, height: 25, text: '<script>alert(1)</script>', strokeColor: 'red" onload="alert(1)' },
      { ...base, id: 'c', type: 'image', x: 0, y: 100, width: 50, height: 50, fileId: 'f' },
    ],
  })
  assertFalse(/<script|href|url\(|\son\w+=|https?:\/\/(?!www\.w3\.org\/2000\/svg")/i.test(svg), svg)
  assertStringIncludes(svg, '&lt;script&gt;alert(1)&lt;/script&gt;')
  // Unsafe colours fall back to the default ink, or to no fill.
  assertStringIncludes(svg, 'stroke="#1e1e1e"')
  assertStringIncludes(svg, 'stroke-dasharray="6 6"')
})

Deno.test('Obsidian drawings, compressed or plain, are read too', () => {
  const json = JSON.stringify(SIMPLE_SCENE)
  const compressed = `# Excalidraw Data\n\n## Drawing\n\`\`\`compressed-json\n${LZString.compressToBase64(json)}\n\`\`\`\n%%`
  const plain = `## Drawing\n\`\`\`json\n${json}\n\`\`\`\n`
  assertEquals(parseDrawing(compressed).length, 4)
  assertEquals(parseDrawing(plain).length, 4)
  assertThrows(() => parseDrawing('# Just a note'))
  assertThrows(() => parseDrawing('{"type":"excalidraw"}'))
  assertThrows(() => parseDrawing('{not json'))
})

Deno.test('empty and oversized scenes are not drawn', () => {
  assertEquals(drawingSvg([]), { problem: 'empty' })
  assertEquals(drawingSvg([{ id: 'x', type: 'frame', x: 0, y: 0, width: 10, height: 10 }]), { problem: 'empty' })
  const many = Array.from({ length: MAX_ELEMENTS + 1 }, (_, i) => ({ ...base, id: `r${i}`, type: 'rectangle', x: i, y: 0, width: 5, height: 5 }))
  assertEquals(drawingSvg(many), { problem: 'too_big' })
  assertEquals(drawingSvg(parseDrawing(JSON.stringify(SIMPLE_SCENE)), 500), { problem: 'too_big' })
})

Deno.test("an arrow's label hides the arrow behind it; a box's label does not", () => {
  const svg = svgOf({
    elements: [
      ...SIMPLE_SCENE.elements,
      { ...base, id: 'said', type: 'text', x: 140, y: 20, width: 40, height: 20, text: 'yes', fontSize: 16, containerId: 'link' },
    ],
  })
  assertEquals(svg.match(/class="label-bg"/g)?.length, 1)
  assertStringIncludes(svg.split('<g ').at(-1)!, '<rect class="label-bg" x="-3" y="-3" width="46" height="26" rx="4" fill="#ffffff"/>')
})

Deno.test("a diagram's generated shapes are filled for the view to colour; an author's fill and a drawing's shapes are not", () => {
  const elements = parseDrawing(JSON.stringify({
    type: 'excalidraw',
    version: 2,
    elements: [
      { ...base, id: 'd2:shape:user', type: 'rectangle', x: 0, y: 0, width: 120, height: 60 },
      { ...base, id: 'd2:shape:db', type: 'ellipse', x: 200, y: 0, width: 100, height: 60, frameId: 'd2:shape:group' },
      { ...base, id: 'd2:shape:own', type: 'rectangle', x: 400, y: 0, width: 100, height: 60, backgroundColor: '#ffc9c9' },
      { ...base, id: 'd2:shape:clear', type: 'rectangle', x: 600, y: 0, width: 100, height: 60, backgroundColor: '#00000000' },
      { ...base, id: 'note', type: 'rectangle', x: 800, y: 0, width: 100, height: 60 },
    ],
  }))
  const diagram = drawingSvg(elements, undefined, { diagram: true })
  assert('svg' in diagram)
  const [, user, db, own, clear, note] = diagram.svg.split('<g ')
  assertStringIncludes(user, 'class="d2-fill"')
  assertStringIncludes(db, 'class="d2-fill2"')
  assertStringIncludes(own, 'fill="#ffc9c9"')
  assertFalse(own.includes('class='))
  assertFalse(clear.includes('class='))
  assertFalse(note.includes('class='))
  // The same shapes in a drawing keep the file's (lack of) fill.
  const drawing = drawingSvg(elements)
  assert('svg' in drawing)
  assertFalse(drawing.svg.includes('class="d2-fill'))
})
