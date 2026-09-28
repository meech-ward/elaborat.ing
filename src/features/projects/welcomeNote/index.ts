import type { StarterFiles } from "@/features/project-storage/localProject"
import flowCanvas from "./flow-canvas.json"
import flowSidecar from "./flow-sidecar.json"
import sketch from "./sketch.json"

/**
 * What a guest's first local project starts with (see `openLocalProject`): a
 * short note that shows what a note can do, and the drawing and diagram it
 * embeds. The diagram's generated files (its canvas and sidecar) are the ones
 * the app itself made from `FLOW`, so the note pictures the diagram without
 * loading the D2 compiler. Only data, loaded only when it is needed.
 */

export const WELCOME_NOTE = "welcome.mdx"

const NOTE = `# Welcome to elaborat.ing

This is a note, written in Markdown with components mixed in (MDX). Switch between the **Source** and **Rendered** views to see both sides, and edit in either one.

<Callout tone="info" title="Make it yours">
Change anything here, then save (Ctrl+S, or Cmd+S on a Mac).
</Callout>

## Drawings and diagrams

A note can show the drawings and diagrams in its project. This is \`sketch.excalidraw\`, a drawing:

<Drawing src="sketch.excalidraw" />

And this is \`flow.d2\`, a diagram written as D2 code and laid out for you:

<Diagram src="flow.d2" />

## Components

Callouts, tabs, cards and charts are built in, and you can write your own.

<Tabs current="Markdown">
  <Tab name="Markdown">

Headings, **bold**, _italics_, lists, links and tables.

  </Tab>
  <Tab name="MDX">

A component is a tag, like \`<Callout>\` above.

  </Tab>
</Tabs>

Your work here is saved in this browser only. Sign up to keep it across devices and to connect agents like Claude or ChatGPT.
`

// Downwards, with both arrows into the project, so it fits a phone's width.
const FLOW = `direction: down
you: You
agent: Your agent
project: This project
you -> project: writes
agent -> project: edits
`

export const WELCOME_FILES: StarterFiles = [
  { path: WELCOME_NOTE, content: NOTE },
  { path: "sketch.excalidraw", content: JSON.stringify(sketch, null, 2) },
  { path: "flow.d2", content: FLOW },
  // As the diagram view saves them (serializeDrawing, writeSidecarFile).
  { path: "flow.excalidraw", content: JSON.stringify(flowCanvas, null, 2) },
  { path: "flow.d2.json", content: `${JSON.stringify(flowSidecar, null, 2)}\n` },
]

