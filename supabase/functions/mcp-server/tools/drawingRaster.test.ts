import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from 'jsr:@std/assert@1.0.19'
import { PhotonImage } from 'npm:@cf-wasm/photon@0.4.0/node'
import { drawingRasters } from './drawingRaster.ts'
import { drawingSvg, parseDrawing } from './drawingSvg.ts'
import { imageDataURL } from '../../../../src/features/images/types.ts'
const image = new PhotonImage(
  new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]),
  2,
  1,
)
const bytes = image.get_bytes()
image.free()
const native = imageDataURL(bytes, 'image/png')
const element = {
  id: 'image',
  type: 'image',
  fileId: 'picture',
  x: 10,
  y: 20,
  width: 120,
  height: 120,
  angle: Math.PI / 4,
  opacity: 45,
  scale: [-1, 1],
  crop: { x: 1, y: 0, width: 1, height: 1, naturalWidth: 2, naturalHeight: 1 },
}
const scene = (
  files: Record<string, unknown>,
  elements: unknown[] = [element],
) => JSON.stringify({ type: 'excalidraw', version: 2, elements, files })
Deno.test('native drawing image previews preserve crop, flip, rotation and opacity with bounded validated pixels', async () => {
  const source = scene({ picture: { dataURL: native, mimeType: 'image/png' } })
  const images = await drawingRasters(source)
  assertEquals(Object.keys(images), ['picture'])
  assertEquals(images.picture.width, 2)
  assertEquals(images.picture.height, 1)
  const result = drawingSvg(parseDrawing(source), 110000, { images })
  assert('svg' in result)
  assertStringIncludes(result.svg, 'href="data:image/webp;base64,')
  assertStringIncludes(result.svg, 'viewBox="1 0 1 1"')
  assertStringIncludes(result.svg, 'scale(-1 1)')
  assertStringIncludes(result.svg, 'rotate(45')
  assertStringIncludes(result.svg, 'opacity="0.45"')
  assertFalse(result.svg.includes('stroke-dasharray="6 6"'))
  assertEquals(
    source,
    scene({ picture: { dataURL: native, mimeType: 'image/png' } }),
  )
})
Deno.test('unsafe native scene entries keep fallback boxes without network or markup authority', async () => {
  const attacks = [
    'https://tracking.example/photo.png',
    'data:image/jpeg;base64,' + native.split(',')[1],
    'data:image/svg+xml;base64,' +
    btoa(
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><foreignObject><script>alert(1)</script></foreignObject></svg>',
    ),
    'data:image/png;base64,AQID',
  ]
  for (const dataURL of attacks) {
    const source = scene({ picture: { dataURL } }),
      images = await drawingRasters(source)
    assertEquals(Object.keys(images), [])
    const result = drawingSvg(parseDrawing(source), 110000, { images })
    assert('svg' in result)
    assertStringIncludes(result.svg, 'stroke-dasharray="6 6"')
    assertFalse(result.svg.includes('<image'))
    assertFalse(result.svg.includes('tracking.example'))
  }
})
Deno.test('native raster previews refuse oversized dimensions and ignore unrelated file entries', async () => {
  const bomb = bytes.slice()
  new DataView(bomb.buffer).setUint32(16, 8_000_001)
  const images = await drawingRasters(
    scene({
      picture: { dataURL: imageDataURL(bomb, 'image/png') },
      unused: { dataURL: native },
    }),
  )
  assertEquals(Object.keys(images), [])
})
Deno.test('invalid crop and untrusted preview URLs never enter the output SVG', () => {
  const invalid = {
    ...element,
    crop: {
      x: 9,
      y: 0,
      width: 1,
      height: 1,
      naturalWidth: 2,
      naturalHeight: 1,
    },
  }
  const result = drawingSvg([invalid], 110000, {
    images: { picture: { dataURL: native, width: 2, height: 1 } },
  })
  assert('svg' in result)
  assertFalse(result.svg.includes('<image'))
  const remote = drawingSvg([element], 110000, {
    images: {
      picture: { dataURL: 'https://tracking.example/x', width: 2, height: 1 },
    },
  })
  assert('svg' in remote)
  assertFalse(remote.svg.includes('tracking.example'))
})
