// How elaborat.ing files are written, so what an agent writes renders in the
// app. One source for the MCP server's instructions (mcp-server/index.ts) and
// the in-app assistant's (chatgpt/tools.ts). Plain TypeScript with no
// imports: the browser and the local token keeper import it too.
export const FILE_FORMAT_INSTRUCTIONS =
  'Projects hold notes, drawings and diagrams. Write new notes as MDX (.mdx): Markdown plus components. ' +
  'Embed a drawing with <Drawing src="path/to/file.excalidraw" /> and a diagram with <Diagram src="path/to/file.d2" />, ' +
  "using the file's path in the project; the file must exist, so create it first. " +
  'A drawing is an Excalidraw scene saved as .excalidraw JSON; a diagram is D2 source saved as .d2. ' +
  'When the user asks you to draw, sketch or diagram something, make a drawing: it is the default for flows, ' +
  'architecture, ideas and any boxes and arrows. Make a D2 diagram only when the user asks for D2, or for a ' +
  'structured diagram that has to be laid out from code: database tables and their relationships, a sequence ' +
  'diagram, or a graph with dozens of connected nodes. ' +
  'Existing .md notes are plain Markdown: keep them as they are unless asked. ' +
  'Create a drawing before the note that embeds it. ' +
  'In a drawing, put elements before appState, and write each shape, then its label, then its arrows. ' +
  "Write straight quotes and apostrophes (' and \"), never curly ones: files are plain text people edit as source. "
