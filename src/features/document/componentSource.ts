/** Reads an imported component file's saved copy. */
export type ComponentSourceLoader = (path: string) => Promise<{text: string; revision: string}>;

/** Module dependencies use saved authority, unlike an editor's draft overlay. */
export function savedComponentSource(file: {content: string; revision: string; savedContent?: string | null}): {text: string; revision: string} {
  if (file.savedContent === null) throw new Error('Save the component module before importing it');
  return {text:file.savedContent === undefined ? file.content : file.savedContent,revision:file.revision};
}
