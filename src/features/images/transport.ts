import { MAX_IMAGE_BYTES, imageDataURL, type ImageMediaType } from "./types";

export const MAX_IMAGE_INTENT_FILES = 8;
export const MAX_IMAGE_INTENT_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_DATA_URL_LENGTH = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 64;
export type ImageFilePayload = {name:string;mediaType:ImageMediaType;dataURL:string};
export type ImagePreview = {dataURL:string;width:number;height:number};

export function decodeImageDataURL(dataURL: string, mediaType?: string): {bytes:Uint8Array;mediaType:ImageMediaType} {
  if (dataURL.length > MAX_IMAGE_DATA_URL_LENGTH) throw new Error("Images must be 5 MiB or smaller.");
  const match = /^data:(image\/(?:png|jpeg|webp|gif|svg\+xml));base64,([A-Za-z\d+/]+={0,2})$/.exec(dataURL);
  if (!match || match[2].length % 4 !== 0 || mediaType && mediaType !== match[1]) throw new Error("Choose a PNG, JPEG, WebP, GIF or SVG image.");
  const decoded = atob(match[2]);
  if (!decoded.length || decoded.length > MAX_IMAGE_BYTES) throw new Error("Images must be 5 MiB or smaller.");
  return {bytes:Uint8Array.from(decoded, char => char.charCodeAt(0)),mediaType:match[1] as ImageMediaType};
}

/** Payloads are proposals for the trusted picker. Its decoder still validates actual file content. */
export function imageFilesFromPayloads(payloads: readonly ImageFilePayload[]): File[] {
  if (!payloads.length || payloads.length > MAX_IMAGE_INTENT_FILES) throw new Error("Choose up to eight images at a time.");
  let total = 0;
  return payloads.map(payload => {
    if (!payload.name || payload.name.length > 255 || /[\\/\u0000-\u001f\u007f]/.test(payload.name)) throw new Error("Choose an image with a valid filename.");
    const {bytes,mediaType} = decodeImageDataURL(payload.dataURL,payload.mediaType);
    total += bytes.length;
    if (total > MAX_IMAGE_INTENT_BYTES) throw new Error("Choose up to 20 MiB of images at a time.");
    return new File([new Uint8Array(bytes).buffer],payload.name,{type:mediaType});
  });
}

export async function imageFilePayloads(files: readonly File[]): Promise<ImageFilePayload[]> {
  if (!files.length || files.length > MAX_IMAGE_INTENT_FILES) throw new Error("Choose up to eight images at a time.");
  if (files.reduce((total,file) => total + file.size,0) > MAX_IMAGE_INTENT_BYTES) throw new Error("Choose up to 20 MiB of images at a time.");
  const payloads:ImageFilePayload[] = [];
  for (const file of files) {
    if (!file.size || file.size > MAX_IMAGE_BYTES) throw new Error("Images must be 5 MiB or smaller.");
    if (!["image/png","image/jpeg","image/webp","image/gif","image/svg+xml"].includes(file.type)) throw new Error("Choose a PNG, JPEG, WebP, GIF or SVG image.");
    const mediaType = file.type as ImageMediaType;
    payloads.push({name:file.name,mediaType,dataURL:imageDataURL(new Uint8Array(await file.arrayBuffer()),mediaType)});
  }
  return payloads;
}
