import type { CSSProperties, ReactNode } from "react"
import { CARD_TEXT, CardView, EditorFrame, EmbedFigure, type CardFile, type CardPreview, type CardState } from "@/chat-card"
import { EmbedBox } from "../ui/EmbedBox"
import { getPaletteColors, useAppearance } from "@/features/appearance"
import { beforeDarkFilter } from "@/features/drawings"
import { SAMPLE_DIAGRAM_SVG, SAMPLE_NOTE_HTML } from "./chatCardSamples"
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
  embeds: [{ kind: "diagram", path: "flows/signup.d2", url: `${PROJECT}/flows/signup.d2`, status: "drawn" }],
  svgs: { "flows/signup.d2": SAMPLE_DIAGRAM_SVG },
  html: SAMPLE_NOTE_HTML,
  source: "# Customer model\n",
  components: null,
  preview: null,
}

const DIAGRAM: CardFile = {
  ...NOTE,
  path: "flows/signup.d2",
  kind: "diagram",
  version: 3,
  url: `${PROJECT}/flows/signup.d2`,
  embeds: [{ kind: "diagram", path: "flows/signup.d2", url: `${PROJECT}/flows/signup.d2`, status: "stale" }],
  html: null,
  source: null,
}

/** A component file an agent is drafting, shown with sample props by preview_component. */
const COMPONENT: CardFile = {
  ...NOTE,
  path: "components/metric.mdx",
  kind: "component",
  version: null,
  url: PROJECT,
  embeds: [],
  svgs: {},
  html: null,
  source: null,
  components: {},
  preview: { component: "Metric", props: { label: "Agents this week", value: 128 }, draft: true },
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

/**
 * A picture of the editor on the note: the rendered editor's text, with the
 * callout and the embed as islands it cannot change (the callout as written).
 */
function EditingSample() {
  return (
    <EditorFrame>
      <div className="ProseMirror">
        <h1>Customer model</h1>
        <p>How a customer moves from sign-up to their first project, and where agents help today.</p>
        <div data-fluid-object="">
          <pre className="island-source">{'<Callout tone="note">\n  Agents act as the signed-in person in every project they can open.\n</Callout>'}</pre>
        </div>
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

/**
 * A picture of what the preview's frame draws for the component: the
 * component in the embed box on the dotted page, with its name under it.
 */
function ComponentSample() {
  return (
    <div className="flex flex-col gap-4 p-4">
      <EmbedBox caption={<code>{"<Metric />"}</code>} className="min-h-[120px] items-stretch">
        <div className="flex flex-col gap-1 text-body">
          <span className="text-xs font-semibold tracking-wide text-dim uppercase">Agents this week</span>
          <span className="text-3xl leading-none font-semibold text-foreground">128</span>
        </div>
      </EmbedBox>
    </div>
  )
}

const SPECIMENS: Array<{ label: string; state: CardState; editor?: ReactNode; preview?: CardPreview }> = [
  { label: "Reading, saved", state: shown(NOTE, { status: { kind: "saved", version: 5 } }) },
  { label: "Editing, unsaved", state: shown(NOTE, { mode: "edit", dirty: true }), editor: <EditingSample /> },
  {
    label: "Conflict",
    state: shown(NOTE, { mode: "conflict", banner: { tone: "warn", text: CARD_TEXT.conflict } }),
    editor: <EditingSample />,
  },
  { label: "Diagram, out of date", state: shown(DIAGRAM) },
  { label: "Draft component preview", state: shown(COMPONENT), preview: { status: "shown", message: null, frame: <ComponentSample /> } },
  {
    label: "Components not shown",
    state: shown({ ...NOTE, components: {} }),
    preview: { status: "failed", message: "No component file at components/chart.mdx.", frame: null },
  },
]

/**
 * The diagram fills the card's build sets from the palette (card.css), here
 * from the one the guide shows: in dark, ahead of the drawings' dark filter.
 */
function useDiagramFills(): CSSProperties {
  const { appearance } = useAppearance()
  const palette = getPaletteColors(appearance)
  const shown = appearance.scheme === "dark" ? beforeDarkFilter : (color: string) => color
  return { "--card-d2-fill": shown(palette.d2Fill), "--card-d2-fill2": shown(palette.d2Fill2) } as CSSProperties
}

export function ChatCardSection() {
  const fills = useDiagramFills()
  return (
    <>
      <GuideValue className="-mt-3.5">
        The card Claude and ChatGPT show for show_file and preview_component, from the same components: the note in the rendered
        note&apos;s type, embeds in the embed box, components in their preview frame, banners, buttons and the save status.
      </GuideValue>
      <div className="grid gap-6 xl:grid-cols-2" style={fills}>
        {SPECIMENS.map(({ label, state, editor, preview }) => (
          <div key={label} className="flex min-w-0 flex-col gap-2">
            <GuideLabel>{label}</GuideLabel>
            <CardView
              aria-label={`Chat card, ${label.toLowerCase()}`}
              state={state}
              canEdit
              editor={editor}
              preview={preview}
              className="max-w-[760px]"
            />
          </div>
        ))}
      </div>
    </>
  )
}
