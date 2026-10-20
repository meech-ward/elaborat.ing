import type { CSSProperties } from 'react';

/** Server-validated small raster pixels, never storage URLs or file credentials. */
export type CardImagePixels = {dataURL:string;width:number;height:number};
export type CardImageRef = {key:string;path:string;status:'ready'|'deferred'|'missing'|'loading';asset?:unknown;revision?:number};
export function cardImageBytes(pixels:CardImagePixels):number {
  const base64 = pixels.dataURL.slice(pixels.dataURL.indexOf(',') + 1);
  return base64.length * 3 / 4 - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
}

/** A responsive image with its description, or a useful fallback while unavailable. */
export function CardImage({pixels,alt,loading=false,url}:{pixels?:CardImagePixels;alt:string;loading?:boolean;url?:string|null}) {
  if (!pixels) return <span className="card-image-missing" role="img" aria-label={alt || 'Image unavailable'}>
    {loading ? 'Loading image…' : alt || 'Image unavailable'}
    {url ? <> <a href={url}>Open in elaborat.ing</a></> : null}
  </span>;
  const style = {maxWidth:'100%',height:'auto',aspectRatio:`${pixels.width}/${pixels.height}`} satisfies CSSProperties;
  return <img className="card-project-image" src={pixels.dataURL} alt={alt} width={pixels.width} height={pixels.height} style={style} loading="lazy" decoding="async" />;
}
