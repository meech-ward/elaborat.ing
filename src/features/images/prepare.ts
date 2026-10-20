import { inspectImage } from "./format";
import {
  IMAGE_PREVIEW_EDGE, MAX_IMAGE_BYTES, MAX_IMAGE_PREVIEW_BYTES, imageDigest, imageObjectKeys,
  type ImageAsset,
} from "./types";

export type PreparedImage = { bytes: Blob; preview: Blob; asset: ImageAsset; name: string; original?: PreparedImage; originalPath?: string };

/** Original bytes stay intact; the browser's decoder checks them and makes a small preview. */
export async function prepareImage(file: File | Blob, projectId: string, id: string = crypto.randomUUID(),signal?:AbortSignal): Promise<PreparedImage> {
  signal?.throwIfAborted();
  if (!file.size || file.size > MAX_IMAGE_BYTES) throw new Error("Choose an image no larger than 5 MiB.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  signal?.throwIfAborted();
  const header = inspectImage(bytes, file.type);
  let bitmap: ImageBitmap | HTMLImageElement;
  let vectorURL: string | null = null;
  try {
    signal?.throwIfAborted();
    if (header.mediaType === "image/svg+xml") {
      const image = new Image();
      vectorURL = URL.createObjectURL(new Blob([bytes], { type: header.mediaType }));
      image.src = vectorURL;
      await image.decode();
      image.width = header.width;
      image.height = header.height;
      bitmap = image;
    } else bitmap = await createImageBitmap(new Blob([bytes], { type: header.mediaType }), { imageOrientation: "from-image" });
  }
  catch { if (vectorURL) URL.revokeObjectURL(vectorURL); signal?.throwIfAborted(); throw new Error("This image could not be decoded. Choose another file."); }
  try {
    signal?.throwIfAborted();
    let preview: Blob | null = null;
    let width = 0, height = 0;
    for (let edge = IMAGE_PREVIEW_EDGE; edge >= 24; edge = Math.floor(edge * 0.7)) {
      const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
      width = Math.max(1, Math.round(bitmap.width * scale));
      height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Image previews are unavailable in this browser.");
      context.drawImage(bitmap, 0, 0, width, height);
      preview = await new Promise(resolve => canvas.toBlob(resolve, "image/webp", 0.78));
      signal?.throwIfAborted();
      if (preview && preview.size <= MAX_IMAGE_PREVIEW_BYTES) break;
    }
    if (!preview || preview.size > MAX_IMAGE_PREVIEW_BYTES) throw new Error("A preview could not be made for this image.");
    const digest=await imageDigest(bytes);
    signal?.throwIfAborted();
    return {
      bytes: new Blob([bytes], { type: header.mediaType }), preview,
      name: file instanceof File ? file.name : "image",
      asset: {
        id, ...imageObjectKeys(projectId, id), media_type: header.mediaType,
        byte_length: bytes.byteLength, width: bitmap.width, height: bitmap.height,
        sha256: digest, preview_type: preview.type === "image/png" ? "image/png" : "image/webp",
        preview_byte_length: preview.size, preview_width: width, preview_height: height,
      },
    };
  } finally { if ("close" in bitmap) bitmap.close(); if (vectorURL) URL.revokeObjectURL(vectorURL); }
}
