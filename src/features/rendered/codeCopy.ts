/** Clipboard writes begin in the click's turn. Isolated previews install a
 * handler that forwards this action to their trusted parent. */
export type CodeCopier = (text: string) => Promise<void>;

let copier: CodeCopier = text => navigator.clipboard.writeText(text);

export function setCodeCopyHandler(handler: CodeCopier): void {
  copier = handler;
}

export function copyCode(text: string): Promise<void> {
  return copier(text);
}
