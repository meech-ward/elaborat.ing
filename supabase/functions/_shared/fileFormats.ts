// How elaborat.ing files are written, so what an agent writes renders in the
// app. One source for the MCP server's instructions (mcp-server/index.ts) and
// the in-app assistant's (chatgpt/tools.ts). Plain TypeScript with no
// imports: the browser and the local token keeper import it too.
export const FILE_FORMAT_INSTRUCTIONS =
  'Projects hold notes, drawings and diagrams. Write new notes as MDX (.mdx): Markdown plus components. ' +
  'Embed a drawing with <Drawing src="path/to/file.excalidraw" /> and a diagram with <Diagram src="path/to/file.d2" />, ' +
  "using the file's path in the project; the file must exist, so create it first. " +
  'A drawing is an Excalidraw scene saved as .excalidraw JSON; a diagram is D2 source saved as .d2. ' +
  'Existing .md notes are plain Markdown: keep them as they are unless asked. ' +
  'Create a drawing before the note that embeds it. ' +
  'In a drawing, put elements before appState, and write each shape, then its label, then its arrows. '
