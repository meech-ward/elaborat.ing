import { equal, rejects } from 'node:assert/strict'
import { PhotonImage } from 'npm:@cf-wasm/photon@0.4.0/node'
import { validateImage } from './images.ts'

const pixel = new PhotonImage(new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]), 2, 1)
const png = pixel.get_bytes(), jpeg = pixel.get_bytes_jpeg(90), webp = pixel.get_bytes_webp()
pixel.free()
Deno.test('decodes all three formats, keeps original identity and bounds preview', async () => {
  for (const [bytes, type] of [[png, 'image/png'], [jpeg, 'image/jpeg'], [webp, 'image/webp']] as const) {
    const image = await validateImage(bytes, type)
    equal(image.width, 2); equal(image.height, 1); equal(image.mediaType, type)
    equal(image.byteLength, bytes.length); equal(image.sha256.length, 64)
    equal(image.thumbnail.length <= 32768, true)
    const decoded = PhotonImage.new_from_byteslice(image.thumbnail)
    equal(decoded.get_width(), 2); equal(decoded.get_height(), 1); decoded.free()
  }
})
Deno.test('refuses mismatched MIME, unsafe SVG, truncated bytes, invalid animation and pixel bombs before allocation', async () => {
  await rejects(() => validateImage(png, 'image/jpeg'), /type/)
  await rejects(() => validateImage(new TextEncoder().encode('<svg/>'), 'image/svg+xml'))
  await rejects(() => validateImage(png.subarray(0, 20)))
  const bomb = png.slice()
  new DataView(bomb.buffer).setUint32(16, 8000001)
  await rejects(() => validateImage(bomb), /million pixels/)
  const animation = new Uint8Array(png.length + 12)
  animation.set(png.subarray(0, 33))
  animation.set([0, 0, 0, 0, 97, 99, 84, 76, 0, 0, 0, 0], 33)
  animation.set(png.subarray(33), 45)
  await rejects(() => validateImage(animation), /Animation/)
  await rejects(() => validateImage(new Uint8Array(5242881)), /5 MiB/)
})
Deno.test('concurrent requests finish with stable metadata and isolated previews', async () => {
  const [one, two] = await Promise.all([validateImage(png), validateImage(webp)])
  equal(one.mediaType, 'image/png'); equal(two.mediaType, 'image/webp')
  equal(one.sha256 === two.sha256, false)
})
Deno.test('JPEG orientation changes preview dimensions while retaining original bytes and digest', async () => {
  const exif = new Uint8Array([255,225,0,34,69,120,105,102,0,0,73,73,42,0,8,0,0,0,1,0,18,1,3,0,1,0,0,0,6,0,0,0,0,0,0,0])
  const oriented = new Uint8Array(jpeg.length + exif.length)
  oriented.set(jpeg.subarray(0, 2)); oriented.set(exif, 2); oriented.set(jpeg.subarray(2), 2 + exif.length)
  const image = await validateImage(oriented, 'image/jpeg')
  equal(image.width, 1); equal(image.height, 2); equal(image.byteLength, oriented.length)
})
Deno.test('all eight JPEG orientations preserve the expected pixel placement',async () => {
  const pixels=new Uint8Array(Array.from({length:6},(_,index)=>[index*40,index*40,index*40,255]).flat())
  const source=new PhotonImage(pixels,2,3)
  const encoded=source.get_bytes_jpeg(100); source.free()
  const reference=PhotonImage.new_from_byteslice(encoded)
  const original=reference.get_raw_pixels(); reference.free()
  const levels=Array.from({length:6},(_,index)=>original[index*4])
  const placements=[[0,1,2,3,4,5],[1,0,3,2,5,4],[5,4,3,2,1,0],[4,5,2,3,0,1],[0,2,4,1,3,5],[4,2,0,5,3,1],[5,3,1,4,2,0],[1,3,5,0,2,4]]
  for (let orientation=1;orientation<=8;orientation++) {
    const exif=new Uint8Array([255,225,0,34,69,120,105,102,0,0,73,73,42,0,8,0,0,0,1,0,18,1,3,0,1,0,0,0,orientation,0,0,0,0,0,0,0])
    const bytes=new Uint8Array(encoded.length+exif.length)
    bytes.set(encoded.subarray(0,2)); bytes.set(exif,2); bytes.set(encoded.subarray(2),2+exif.length)
    const image=await validateImage(bytes,'image/jpeg')
    const preview=PhotonImage.new_from_byteslice(image.thumbnail)
    try {
      equal(preview.get_width(),orientation>=5 ? 3 : 2)
      equal(preview.get_height(),orientation>=5 ? 2 : 3)
      const data=preview.get_raw_pixels()
      const actual=Array.from({length:6},(_,index)=>levels.map((level,original)=>({original,difference:Math.abs(level-data[index*4])})).sort((one,two)=>one.difference-two.difference)[0].original)
      equal(actual.join(','),placements[orientation-1].join(','),`orientation ${orientation}`)
    } finally {preview.free()}
  }
})
Deno.test('SVG and GIF use bounded raster thumbnails, with no vector markup in the preview', async () => {
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><rect width="100" height="50" fill="red"/></svg>')
  const vector = await validateImage(svg, 'image/svg+xml')
  equal(vector.mediaType, 'image/svg+xml'); equal(vector.width, 100); equal(vector.height, 50)
  equal(vector.thumbnailType, 'image/png'); equal(vector.thumbnail[0], 137)
  const gif = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), char => char.charCodeAt(0))
  const animated = await validateImage(gif, 'image/gif')
  equal(animated.mediaType, 'image/gif'); equal(animated.thumbnailType, 'image/webp')
})

Deno.test('SVG text has visible pixels with the bundled fallback, including missing and generic families',async () => {
  const pixels=async (body:string) => {
    const source=new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40">${body}</svg>`)
    const image=await validateImage(source,'image/svg+xml')
    const preview=PhotonImage.new_from_byteslice(image.thumbnail)
    try {
      const rgba=preview.get_raw_pixels()
      return {image,visible:rgba.filter((alpha,index)=>index%4===3 && alpha>0).length}
    } finally {preview.free()}
  }
  equal((await pixels('')).visible,0)
  for (const family of ['', 'Arial', 'serif', 'sans-serif', 'monospace', 'Missing Font']) {
    const text=await pixels(`<text x="4" y="30" font-size="26" font-family="${family}">Hello</text>`)
    equal(text.visible>100,true,`SVG text is blank for ${family || 'the default font'}`)
    equal(text.image.thumbnail.length<=32768,true)
    equal(text.image.width,120); equal(text.image.height,40)
  }
  const shape=await pixels('<rect x="90" y="5" width="20" height="20"/>')
  const mixed=await pixels('<rect x="90" y="5" width="20" height="20"/><text x="4" y="30" font-size="26">Hello</text>')
  equal(shape.visible,400)
  equal(mixed.visible>shape.visible+100,true)
})

Deno.test('SVG glyph budgets reject oversized and reused text before the font renderer',async () => {
  const svg=(body:string)=>new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20">${body}</svg>`)
  await rejects(()=>validateImage(svg(`<text>${'@'.repeat(4001)}</text>`),'image/svg+xml'),/4,000/)
  await rejects(()=>validateImage(svg(`<text>${'@'.repeat(4000)}</text><text>${'@'.repeat(4000)}</text><text>@</text>`),'image/svg+xml'),/8,000/)
  await rejects(()=>validateImage(svg(`<defs><text id="word">${'@'.repeat(1000)}</text></defs>${'<use href="#word"/>'.repeat(8)}`),'image/svg+xml'),/repeated text/)
})
