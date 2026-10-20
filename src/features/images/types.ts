import { z } from "zod/mini";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 8_000_000;
export const MAX_IMAGE_PREVIEW_BYTES = 32 * 1024;
export const IMAGE_PREVIEW_EDGE = 480;
export const IMAGE_BUCKET = "project-images";
export const ImageMediaTypeSchema = z.enum(["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"]);
export type ImageMediaType = z.infer<typeof ImageMediaTypeSchema>;
const positive = z.int().check(z.positive());
export const ImageAssetSchema = z.object({
  id: z.uuid(),
  media_type: ImageMediaTypeSchema,
  byte_length: positive.check(z.maximum(MAX_IMAGE_BYTES)),
  width: positive,
  height: positive,
  sha256: z.string().check(z.regex(/^[a-f0-9]{64}$/)),
  object_key: z.string().check(z.regex(/^[a-f0-9-]{36}\/[a-f0-9-]{36}\/original$/i)),
  preview_key: z.string().check(z.regex(/^[a-f0-9-]{36}\/[a-f0-9-]{36}\/preview$/i)),
  preview_type: z.enum(["image/png", "image/jpeg", "image/webp"]),
  preview_byte_length: positive.check(z.maximum(MAX_IMAGE_PREVIEW_BYTES)),
  draft_note: z.optional(z.string().check(z.maxLength(512), z.refine(path => /\.mdx?$/i.test(path) && !/[\\:\u0000-\u001f\u007f]/.test(path) && path.split("/").every(part => part.length > 0 && !part.startsWith("."))))),
  // Local draft dependency only. The server stores immutable asset identity.
  original_path: z.optional(z.string().check(z.maxLength(512), z.refine(path => !/[\\:\u0000-\u001f\u007f]/.test(path) && path.split("/").every(part => part.length > 0 && !part.startsWith("."))))),
  preview_width: z.optional(positive),
  preview_height: z.optional(positive),
}).check(
  z.refine(asset => asset.width * asset.height <= MAX_IMAGE_PIXELS, "The image is too large."),
  z.refine(asset => asset.object_key.split("/")[1] === asset.id && asset.preview_key === asset.object_key.replace(/original$/, "preview"), "Invalid image storage identity."),
);
export type ImageAsset = z.infer<typeof ImageAssetSchema>;

export function imageObjectKeys(projectId: string, assetId: string) {
  z.uuid().parse(projectId);
  z.uuid().parse(assetId);
  return { object_key: `${projectId}/${assetId}/original`, preview_key: `${projectId}/${assetId}/preview` };
}

export function isImagePath(path: string): boolean {
  return /\.(?:png|jpe?g|webp|gif|svg)$/i.test(path);
}

export function imageExtension(mediaType: ImageMediaType): string {
  return mediaType === "image/jpeg" ? "jpg" : mediaType === "image/svg+xml" ? "svg" : mediaType.slice("image/".length);
}

export async function imageDigest(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export function imageDataURL(bytes: Uint8Array, mediaType: ImageMediaType): string {
  let text = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    text += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return `data:${mediaType};base64,${btoa(text)}`;
}
