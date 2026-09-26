import nativeFont from '../structured/native-font.json';
import { excalidrawAssetBase } from './assets.ts';

// Generated D2 text uses the exact pinned native family 5. Load it before the
// first canvas paint: the native renderer can otherwise cache fallback glyphs
// before its asynchronous font notification. Keep this independent of scene
// restoration and authored bytes, including later updateScene introductions.
let ready: Promise<void> | undefined;

export function ensureGeneratedNativeFont(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    const descriptors = [
      ...nativeFont.faces.map(face => ({family:'Excalifont',path:face.path,unicodeRange:face.unicodeRange})),
      // Earlier generated scenes retain family 9 and still need correct first paint.
      {family:'Liberation Sans',path:'Liberation/LiberationSans-Regular.woff2',unicodeRange:'U+0-10FFFF'},
    ];
    const faces = await Promise.all(descriptors.map(async ({family,path,unicodeRange}) => {
      const url = new URL(`fonts/${path}`, excalidrawAssetBase());
      const face = new FontFace(family, `url("${url.href}")`, {
        style:'normal',weight:'400',display:'swap',unicodeRange,
      });
      return face.load();
    }));
    for (const face of faces) document.fonts.add(face);
  })().catch((error: unknown) => {
    ready = undefined;
    throw new Error(`Generated drawing font failed to load: ${error instanceof Error ? error.message : String(error)}`);
  });
  return ready;
}
