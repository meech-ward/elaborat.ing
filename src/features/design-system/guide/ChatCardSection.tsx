import { CARD_TEXT, CardView, EditorFrame, EmbedFigure, type CardFile, type CardState } from "@/chat-card"
import { SAMPLE_DRAWING_SVG, SAMPLE_NOTE_HTML } from "./chatCardSamples"
import { GuideLabel, GuideValue } from "./parts"

// The chat card (the view of show_file in Claude and ChatGPT) in its states,
// built from the same components, next to the rest of the library.

const PROJECT = "https://elaborat.ing/projects/6f1c2d3e-4b5a-4c6d-8e7f-901a2b3c4d5e"

const NOTE: CardFile = {
  projectId: "6f1c2d3e-4b5a-4c6d-8e7f-901a2b3c4d5e",
  path: "docs/customer-model.mdx",
  kind: "note",
  version: 5,
  url: `${PROJECT}/docs/customer-model.mdx`,
  truncated: false,
  embeds: [{ kind: "drawing", path: "art/flow.excalidraw", url: `${PROJECT}/art/flow.excalidraw`, status: "drawn" }],
  svgs: { "art/flow.excalidraw": SAMPLE_DRAWING_SVG },
  html: SAMPLE_NOTE_HTML,
  source: "# Customer model\n",
}

const DIAGRAM: CardFile = {
  ...NOTE,
  path: "flows/signup.d2",
  kind: "diagram",
  version: 3,
  url: `${PROJECT}/flows/signup.d2`,
  embeds: [{ kind: "diagram", path: "flows/signup.d2", url: `${PROJECT}/flows/signup.d2`, status: "stale" }],
  svgs: { "flows/signup.d2": SAMPLE_DRAWING_SVG },
  html: null,
  source: null,
}

const shown = (file: CardFile, rest: Partial<Extract<CardState, { phase: "shown" }>> = {}): CardState => ({
  phase: "shown",
  file,
  mode: "read",
  busy: false,
  dirty: false,
  status: { kind: "none" },
  banner: null,
  ...rest,
})

/** A picture of the editor on the note: the rendered editor's text, with the embed as an island it cannot change. */
function EditingSample() {
  return (
    <EditorFrame>
      <div className="ProseMirror">
        <h1>Customer model</h1>
        <p>How a customer moves from sign-up to their first project, and where agents help today.</p>
        <ol>
          <li>Sign up with an email link.</li>
          <li>Create a project.</li>
          <li>Connect an agent.</li>
        </ol>
        <div data-fluid-object="">
          <EmbedFigure embed={NOTE.embeds[0]!} svgs={NOTE.svgs} />
        </div>
      </div>
    </EditorFrame>
  )
}

const SPECIMENS = [
  { label: "Reading, saved", state: shown(NOTE, { status: { kind: "saved", version: 5 } }) },
  { label: "Editing, unsaved", state: shown(NOTE, { mode: "edit", dirty: true }), editor: <EditingSample /> },
  {
    label: "Conflict",
    state: shown(NOTE, { mode: "conflict", banner: { tone: "warn", text: CARD_TEXT.conflict } }),
    editor: <EditingSample />,
  },
  { label: "Diagram, out of date", state: shown(DIAGRAM) },
]

export function ChatCardSection() {
  return (
    <>
      <GuideValue className="-mt-3.5">
        The card Claude and ChatGPT show for show_file, from the same components: the note in the rendered note&apos;s type, embeds in the
        embed box, banners, buttons and the save status.
      </GuideValue>
      <div className="grid gap-6 xl:grid-cols-2">
        {SPECIMENS.map(({ label, state, editor }) => (
          <div key={label} className="flex min-w-0 flex-col gap-2">
            <GuideLabel>{label}</GuideLabel>
            <CardView aria-label={`Chat card, ${label.toLowerCase()}`} state={state} canEdit editor={editor} className="max-w-[760px]" />
          </div>
        ))}
      </div>
    </>
  )
}
