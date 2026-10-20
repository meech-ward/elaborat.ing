import { inspectSVG } from "./svg.ts";
import { imageSize } from "image-size";
import { MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS, type ImageMediaType } from "./types.ts";

const ascii = (bytes: Uint8Array, from: number, size: number) =>
  String.fromCharCode(...bytes.subarray(from, from + size));

/** Inspect bounded raster headers before a decoder allocates their pixels. */
export function inspectImage(bytes: Uint8Array, claimedType?: string) {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES)
    throw new Error("Choose an image no larger than 5 MiB.");
  let mediaType: ImageMediaType;
  let frames = 0;
  let framePixels = 0;
  const rectangles: Array<{width:number;height:number;x:number;y:number}> = [];
  const checkFrames = (width:number,height:number,x=0,y=0) => {
    if (!width || !height || width * height > MAX_IMAGE_PIXELS) throw new Error("The animation frame is too large.");
    if (++frames > 120 || (framePixels += width * height) > 24_000_000) throw new Error("Animation exceeds 120 frames or 24 million decoded frame pixels.");
    rectangles.push({width,height,x,y});
  };
  if (bytes[0] === 60 || new TextDecoder().decode(bytes.subarray(0, 100)).trimStart().startsWith("<")) {
    const svg = inspectSVG(bytes);
    if (svg.width * svg.height > MAX_IMAGE_PIXELS) throw new Error("Choose an SVG with at most 8 million pixels.");
    if (claimedType && !["image/svg+xml", "application/octet-stream"].includes(claimedType)) throw new Error("The file contents do not match its image type.");
    return { mediaType: "image/svg+xml" as const, width: svg.width, height: svg.height, orientation: 1, animated: false };
  }
  if (bytes.length >= 24 && ascii(bytes, 1, 3) === "PNG" && bytes[0] === 137) {
    mediaType = "image/png";
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let ended = false;
    let declaredFrames:number | undefined;
    for (let at = 8; at + 12 <= bytes.length;) {
      const size = view.getUint32(at);
      if (size > bytes.length - at - 12) throw new Error("The PNG image is incomplete.");
      const kind = ascii(bytes, at + 4, 4);
      if (kind === "acTL") {
        if (size !== 8 || !view.getUint32(at + 8) || view.getUint32(at + 8) > 120) throw new Error("Animation exceeds 120 frames or is invalid.");
        if (declaredFrames !== undefined) throw new Error("The animation is invalid.");
        declaredFrames = view.getUint32(at + 8);
      }
      if (kind === "fcTL") {
        if (size !== 26 || declaredFrames === undefined) throw new Error("The animation is invalid.");
        checkFrames(view.getUint32(at + 12),view.getUint32(at + 16),view.getUint32(at + 20),view.getUint32(at + 24));
      }
      at += size + 12;
      if (kind === "IEND") {
        ended = size === 0 && at === bytes.length;
        break;
      }
    }
    if (!ended) throw new Error("The PNG image is incomplete.");
    if (declaredFrames !== undefined && declaredFrames !== frames) throw new Error("The animation frame count is invalid.");
  } else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    mediaType = "image/jpeg";
    if (bytes.at(-2) !== 255 || bytes.at(-1) !== 217)
      throw new Error("The JPEG image is incomplete.");
  } else if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    mediaType = "image/webp";
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(4, true) !== bytes.length - 8) throw new Error("The WebP image is incomplete.");
    let at = 12;
    for (; at + 8 <= bytes.length;) {
      const size = view.getUint32(at + 4, true);
      if (size > bytes.length - at - 8) throw new Error("The WebP image is incomplete.");
      const kind = ascii(bytes, at, 4);
      if (kind === "ANMF") {
        if (size < 16) throw new Error("The animation is invalid.");
        const value = (offset: number) => bytes[offset] + bytes[offset + 1] * 256 + bytes[offset + 2] * 65536;
        checkFrames(value(at + 14)+1,value(at + 17)+1,value(at + 8)*2,value(at + 11)*2);
      }
      if (size % 2 && bytes[at + 8 + size] !== 0) throw new Error("The WebP padding is invalid.");
      at += 8 + size + (size % 2);
    }
    if (at !== bytes.length) throw new Error("The WebP image is incomplete.");
  } else if (["GIF87a", "GIF89a"].includes(ascii(bytes, 0, 6))) {
    mediaType = "image/gif";
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 14) throw new Error("The GIF image is incomplete.");
    let at = 13 + (bytes[10] & 128 ? 3 * (2 ** ((bytes[10] & 7) + 1)) : 0), ended = false;
    const blocks = () => { while (at < bytes.length) { const size = bytes[at++]; if (!size) return; at += size; } throw new Error("The GIF image is incomplete."); };
    while (at < bytes.length) {
      const marker = bytes[at++];
      if (marker === 59) { ended = at === bytes.length; break; }
      if (marker === 33) { at++; blocks(); }
      else if (marker === 44) {
        if (at + 9 > bytes.length) throw new Error("The GIF image is incomplete.");
        const width = view.getUint16(at + 4, true), height = view.getUint16(at + 6, true), packed = bytes[at + 8];
        checkFrames(width,height,view.getUint16(at,true),view.getUint16(at+2,true)); at += 9 + (packed & 128 ? 3 * (2 ** ((packed & 7) + 1)) : 0);
        const codeSize = bytes[at++];
        if (codeSize < 2 || codeSize > 8 || codeSize === undefined) throw new Error("The GIF image is invalid.");
        blocks();
      } else throw new Error("The GIF image is invalid.");
    }
    if (!ended || !frames) throw new Error("The GIF image is incomplete.");
  } else {
    throw new Error("Choose a PNG, JPEG, WebP, GIF or SVG image.");
  }
  if (claimedType && claimedType !== "application/octet-stream" && claimedType !== mediaType)
    throw new Error("The file's contents do not match its image type.");
  let dimensions: ReturnType<typeof imageSize>;
  try { dimensions = imageSize(bytes); }
  catch { throw new Error("This image could not be read. Choose another file."); }
  const { width, height } = dimensions;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > MAX_IMAGE_PIXELS)
    throw new Error(`Choose an image with at most ${MAX_IMAGE_PIXELS / 1_000_000} million pixels.`);
  for (const frame of rectangles) if (frame.x + frame.width > width || frame.y + frame.height > height)
    throw new Error("An animation frame extends beyond the image canvas.");
  // Browsers composite even tiny delta rectangles on a full-sized canvas.
  // Counting only rectangle pixels would allow a small file to retain huge frames.
  if (frames * width * height > 24_000_000) throw new Error("Animation exceeds 24 million decoded frame pixels.");
  return { mediaType, width, height, orientation: dimensions.orientation ?? 1, animated: frames > 1 };
}
