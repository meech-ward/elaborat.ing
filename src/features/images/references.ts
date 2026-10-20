import type { DocumentFormat, SourcePatch } from "../document";
import type { ImageReference } from "./referenceParser.ts";
import { imageMarkdown, relativeImagePath } from "./paths";
import { captionMarkdown, imageFigureMarkdown } from './captions';
export { parseImageReferences, literalHtmlImage, type ImageReference } from "./referenceParser.ts";
export { imageMarkdown, imageReferenceKey, relativeImagePath, resolveImagePath } from "./paths";

/** Replace one parser-owned reference, leaving a shared definition and all unrelated source intact. */
export function imageReferencePatch(source: string, reference: ImageReference, owner: string, next: {path:string;alt:string;caption?:string} | null, format: DocumentFormat): SourcePatch {
  if (reference.sourcePath !== owner || reference.from < 0 || reference.to > source.length) throw new Error("This image belongs to another source file.");
  const newline = /\r\n|\n|\r/.exec(source)?.[0] ?? '\n';
  const ending = (text:string) => text.replace(/\r\n|\r|\n/g,newline);
  if (!next && reference.figure) return {from:reference.figure.from,to:reference.figure.to,expected:source.slice(reference.figure.from,reference.figure.to),insert:''};
  const image = next ? imageMarkdown(relativeImagePath(owner,next.path),next.alt,format) : '';
  if (next?.caption !== undefined && reference.figure) return {
    from:reference.from,to:reference.figure.captionTo,expected:source.slice(reference.from,reference.figure.captionTo),
    insert:ending(image + source.slice(reference.to,reference.figure.captionFrom) + (next.caption.trim() ? captionMarkdown(next.caption,format) : '')),
  };
  if (next?.caption?.trim()) {
    const start = source.lastIndexOf('\n',reference.from-1)+1;
    const end = source.indexOf('\n',reference.to);
    if (source.slice(start,reference.from).trim() || source.slice(reference.to,end === -1 ? source.length : end).trim())
      throw new Error('Put this image on its own line before adding a caption.');
    return {from:reference.from,to:reference.to,expected:source.slice(reference.from,reference.to),insert:ending(imageFigureMarkdown(relativeImagePath(owner,next.path),next.alt,next.caption,format))};
  }
  return {from:reference.from,to:reference.to,expected:source.slice(reference.from,reference.to),insert:image};
}
