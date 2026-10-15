// brotli (brotli.js) ships no types: its decompressor, as the chat card's
// D2 engine worker uses it (engine.worker.ts).
declare module "brotli/decompress" {
  /** Brotli-compressed bytes, decompressed into `outputSize` bytes (the size of the first meta-block when left out). */
  export default function decompress(buffer: Uint8Array, outputSize?: number): Uint8Array<ArrayBuffer>
}
