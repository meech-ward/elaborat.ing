/** Logical identities are raw project paths; URL decoding belongs only to references. */
export function safeImagePath(path: string): boolean {
  return path.length > 0 && path.length <= 512 && /\.(?:png|jpe?g|webp|gif|svg)$/i.test(path) &&
    !/[\\:\u0000-\u001f\u007f]/.test(path) &&
    path.split("/").every(segment => segment.length > 0 && !segment.startsWith("."));
}

/** Resolve a source URL relative to its note/module, never outside its project. */
export function resolveImagePath(owner: string, src: string): string | null {
  if (!src || src.length > 1536 || /[?#\\\u0000-\u001f\u007f]/.test(src) ||
      /^(?:\/|[a-z][a-z\d+.-]*:)/i.test(src) || /%(?:2f|5c)/i.test(src)) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(src); } catch { return null; }
  if (/[\\:\u0000-\u001f\u007f]/.test(decoded) || decoded.startsWith("/")) return null;
  const parts = owner.split("/").slice(0, -1);
  for (const segment of decoded.split("/")) {
    if (segment === ".") continue;
    if (segment === "..") { if (!parts.length) return null; parts.pop(); }
    else if (!segment || segment.startsWith(".")) return null;
    else parts.push(segment);
  }
  const path = parts.join("/");
  return safeImagePath(path) ? path : null;
}

/** The encoded, document-relative URL to a raw project image identity. */
export function relativeImagePath(owner: string, target: string): string {
  if (!safeImagePath(target)) throw new Error("Choose a valid project image.");
  const base = owner.split("/").slice(0, -1), destination = target.split("/");
  let shared = 0;
  while (shared < base.length && shared < destination.length && base[shared] === destination[shared]) shared++;
  return [...base.slice(shared).map(() => ".."), ...destination.slice(shared).map(part =>
    encodeURIComponent(part).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`),
  )].join("/");
}

/** Module-local URLs need distinct keys when two modules use the same literal. */
export function imageReferenceKey(modulePath: string | null, src: string): string {
  return modulePath === null ? src : `workspace:${modulePath}#image:${src}`;
}
