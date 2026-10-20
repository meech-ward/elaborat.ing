// The in-app assistant's tools and instructions, defined once: the local
// token keeper (and later the hosted function) pins them into every request
// (responses.ts), and the browser runs the calls they produce
// (src/features/assistant/bridge.ts). Plain TypeScript with no packages, so
// Deno, Bun and the browser all import it as it is.
import { FILE_FORMAT_INSTRUCTIONS } from '../fileFormats.ts'

export const NAMESPACE = 'elaborating'

export const TOOL_NAMES = ['list_files', 'read_file', 'write_file', 'list_comments', 'get_image_preview', 'import_image'] as const
export type ToolName = (typeof TOOL_NAMES)[number]

const pathParameter = {
  type: 'string',
  description: 'The file\'s path in the project, such as "notes/plan.mdx" or "art/flow.excalidraw".',
}

/** The tools, grouped in one namespace as the Responses API takes them. */
export const TOOL_NAMESPACE = {
  type: 'namespace',
  name: NAMESPACE,
  description: 'The notes, drawings and diagrams in the elaborat.ing project the person has open.',
  tools: [
    {
      type: 'function',
      name: 'list_files',
      description: "Lists the project's files with their kind (note, drawing, diagram or text), and which have unsaved changes.",
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      strict: true,
    },
    {
      type: 'function',
      name: 'read_file',
      description:
        "Reads a file as the person's editor holds it, including their unsaved changes, with its version. Read a file before you change it.",
      parameters: { type: 'object', properties: { path: pathParameter }, required: ['path'], additionalProperties: false },
      strict: true,
    },
    {
      type: 'function', name: 'get_image_preview',
      description: 'Inspect a small image preview from this project. read_file returns image metadata without binary data. Reuse an existing image in a note with ordinary relative Markdown syntax.',
      parameters: { type: 'object', properties: { path: pathParameter }, required: ['path'], additionalProperties: false }, strict: true,
    },
    {
      type: 'function', name: 'import_image',
      description: 'Only when the person explicitly asks to import a URL: download a public HTTPS PNG, JPEG or WebP into a new project image draft. This makes a network request. The person saves the note referencing this image to save both together.',
      parameters: { type: 'object', properties: { path: pathParameter, url: { type: 'string', description: 'Direct public HTTPS image URL supplied or authorized by the person.' } }, required: ['path', 'url'], additionalProperties: false }, strict: true,
    },
    {
      type: 'function',
      name: 'write_file',
      description:
        "Replaces a file's whole content, or creates the file when the path is new. Always give the complete file, never a part. " +
        'The app opens the file and shows your version as unsaved changes: nothing is saved until the person saves it.',
      parameters: {
        type: 'object',
        properties: { path: pathParameter, content: { type: 'string', description: 'The complete new content of the file.' } },
        required: ['path', 'content'],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: 'function',
      name: 'list_comments',
      description: 'Lists the open comment threads on a file: what each is on, and its comments. Read only.',
      parameters: { type: 'object', properties: { path: pathParameter }, required: ['path'], additionalProperties: false },
      strict: true,
    },
  ],
} as const

/** What the assistant is told before every request. The file formats are the MCP server's text. */
export const ASSISTANT_INSTRUCTIONS =
  'You are the assistant inside elaborat.ing, working in the project the person has open, with their access. ' +
  FILE_FORMAT_INSTRUCTIONS +
  'Use list_files to see the project, and read_file before you change a file. ' +
  'Images are binary: read_file returns metadata; use get_image_preview to inspect one. Reuse its document-relative path with ![description](../images/name.png). Remote URLs never render automatically. Only use import_image when the person explicitly asks to import that URL. ' +
  "write_file replaces a file's whole content, so always write the complete file. " +
  'It shows your version to the person as unsaved changes, and they save or discard it. ' +
  'If they keep their own changes instead, do not write that file again unless they ask. ' +
  'list_comments shows the open comment threads on a file; you cannot reply to or resolve them. ' +
  'Keep your replies short and plain.'

/**
 * The tool a function call item names, or null for anything else: a name
 * outside the declared tools, or another namespace. Calls name their tool with
 * `name`, and the namespace in `namespace` (or, defensively, as a prefix).
 */
export function toolNameOf(item: { name?: unknown; namespace?: unknown }): ToolName | null {
  if (typeof item.name !== 'string') return null
  if (item.namespace !== undefined && item.namespace !== null && item.namespace !== NAMESPACE) return null
  const name = item.name.startsWith(`${NAMESPACE}.`) ? item.name.slice(NAMESPACE.length + 1) : item.name
  return (TOOL_NAMES as readonly string[]).includes(name) ? (name as ToolName) : null
}
