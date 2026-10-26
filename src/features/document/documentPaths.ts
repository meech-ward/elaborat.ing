/** Document embeds address one literal project-root note identity, never a URL. */
export function isDocumentPath(path: string): boolean {
  return path.length > 0 && path.length <= 512 && /\.(?:md|mdx)$/i.test(path) && !/\.excalidraw\.md$/i.test(path) &&
    path.normalize('NFC') === path && new TextEncoder().encode(path).length <= 1024 &&
    !/[\\:\u0000-\u001f\u007f-\u009f]/.test(path) &&
    path.split('/').every(segment => segment.length > 0 && !segment.startsWith('.'));
}
