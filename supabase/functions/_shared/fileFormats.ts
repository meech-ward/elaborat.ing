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
  'In a drawing, put elements before appState, and write each shape, then its arrows, in short form: ' +
  'a rectangle, ellipse or diamond with x, y and a label and no width or height is sized to fit the label, ' +
  'and an arrow with from and to, the ids of the two shapes it joins, is placed between them and bound to both, such as ' +
  '{"id": "api", "type": "rectangle", "x": 0, "y": 0, "label": "API"}, {"id": "db", "type": "ellipse", "x": 300, "y": 0, "label": "Database"}, ' +
  '{"id": "api-to-db", "type": "arrow", "from": "api", "to": "db", "label": "SQL"}. ' +
  'The drawing is written with the full Excalidraw elements, each label a text with the id "<id>-label"; full elements work too. ' +
  "To change a shape's or arrow's label, give it the new label in short form: it replaces the old label text. " +
  "Write straight quotes and apostrophes (' and \"), never curly ones: files are plain text people edit as source. "
