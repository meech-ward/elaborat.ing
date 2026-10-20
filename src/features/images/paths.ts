import { encodeProseText, type DocumentFormat } from "../document";
export { safeImagePath, resolveImagePath, relativeImagePath, imageReferenceKey } from "./referencePaths.ts";

export function imageMarkdown(src: string, alt: string, format: DocumentFormat = "mdx"): string {
  if (alt.length > 2048 || /[\r\n\u0000]/.test(alt)) throw new Error("Image descriptions must be one line, up to 2,048 characters.");
  return `![${encodeProseText(alt, format)}](${src})`;
}
