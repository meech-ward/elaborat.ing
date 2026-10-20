import { PhotonImage, resize, fliph, flipv, SamplingFilter } from 'npm:@cf-wasm/photon@0.4.0/node'
import { inspectImage } from '../../../src/features/images/format.ts'
import { IMAGE_PREVIEW_EDGE, MAX_IMAGE_PREVIEW_BYTES, imageDigest } from '../../../src/features/images/types.ts'

// WASM keeps its largest allocation. One decode at a time bounds an isolate's
// high-water mark instead of multiplying it for simultaneous requests.
let decoding = Promise.resolve()
export async function validateImage(bytes: Uint8Array, claimedType?: string) {
  const previous = decoding
  let release!: () => void
  decoding = new Promise<void>(resolve => { release = resolve })
  await previous
  try {
    const header = inspectImage(bytes, claimedType)
    if (header.mediaType === 'image/svg+xml') {
      const { Resvg } = await import('npm:@cf-wasm/resvg@0.4.0/node')
      let edge = IMAGE_PREVIEW_EDGE
      while (edge >= 24) {
        const renderer = await Resvg.async(bytes, {
          font: { loadSystemFonts: false },
          fitTo: { mode: 'zoom', value: Math.min(1, edge / Math.max(header.width, header.height)) },
        })
        let thumbnail: Uint8Array
        try {
          const rendered = renderer.render()
          try { thumbnail = rendered.asPng() } finally { rendered.free() }
        } finally { renderer.free() }
        if (thumbnail.length <= MAX_IMAGE_PREVIEW_BYTES) return {
          mediaType: header.mediaType, width: header.width, height: header.height,
          sha256: await imageDigest(bytes), byteLength: bytes.length, thumbnail, thumbnailType: 'image/png' as const,
        }
        edge = Math.floor(edge * 0.7)
      }
      throw new Error('A preview could not be made for this SVG.')
    }
    let image: PhotonImage
    let freed=false
    try { image = PhotonImage.new_from_byteslice(bytes) }
    catch { throw new Error('This image could not be decoded. Choose another file.') }
    try {
      if (image.get_width() !== header.width || image.get_height() !== header.height)
        throw new Error('The image dimensions are inconsistent.')
      if (header.orientation >= 5 && header.orientation <= 8) {
        const width=image.get_width(),height=image.get_height(),source=image.get_raw_pixels()
        const oriented=new Uint8Array(source.length)
        for (let y=0;y<height;y++) for (let x=0;x<width;x++) {
          const targetX=header.orientation === 6 || header.orientation === 7 ? height-1-y : y
          const targetY=header.orientation === 7 || header.orientation === 8 ? width-1-x : x
          const from=(y*width+x)*4,to=(targetY*height+targetX)*4
          oriented[to]=source[from]; oriented[to+1]=source[from+1]; oriented[to+2]=source[from+2]; oriented[to+3]=source[from+3]
        }
        // Quarter turns are pixel permutations. Photon.rotate resamples them,
        // introducing interpolated/white pixels even at exactly 90 degrees.
        image.free(); freed=true
        image=new PhotonImage(oriented,height,width); freed=false
      } else {
        if ([2,3].includes(header.orientation)) fliph(image)
        if ([3,4].includes(header.orientation)) flipv(image)
      }
      const width = image.get_width(), height = image.get_height()
      for (let edge = IMAGE_PREVIEW_EDGE; edge >= 24; edge = Math.floor(edge * 0.7)) {
        const scale = Math.min(1, edge / Math.max(width, height))
        const preview = resize(image, Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)), SamplingFilter.Lanczos3)
        let thumbnail: Uint8Array
        try { thumbnail = preview.get_bytes_webp() } finally { preview.free() }
        if (thumbnail.byteLength <= MAX_IMAGE_PREVIEW_BYTES) return {
          mediaType: header.mediaType, width, height, sha256: await imageDigest(bytes), byteLength: bytes.byteLength,
          thumbnail, thumbnailType: 'image/webp' as const,
        }
      }
      throw new Error('A preview could not be made for this image.')
    } finally { if (!freed) image.free() }
  } finally { release() }
}
