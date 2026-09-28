import { useEffect, useRef, useState, type ReactNode } from "react"
import { ChevronLeft, Info, Maximize2, Minimize2, MoreHorizontal } from "lucide-react"
import { DottedPage } from "@/components/panel"
import { Button } from "@/components/ui/button"
import { ensureGeneratedNativeFont } from "@/features/drawings"
import { cn } from "@/lib/utils"
import { Callout } from "../ui/Banner"
import { CanvasIsland, ToolButton, ToolGroup, ZoomControl, islandTools } from "../ui/CanvasIsland"
import { CommentComposer } from "../ui/CommentComposer"
import { CommentActionButton, CommentHighlight, CommentMarker, CommentsButton, DetachedBadge } from "../ui/CommentMarker"
import { CommentsPanel, CommentsSheet } from "../ui/CommentsPanel"
import { CommentAnchorLine, CommentDraft, CommentThread } from "../ui/CommentThread"
import type { CommentAnchorView } from "../ui/commentTypes"
import { EditorHeader } from "../ui/EditorHeader"
import { FloatingPanel } from "../ui/FloatingPanel"
import { IconButton, RoundIconButton } from "../ui/IconButton"
import { KindBadge } from "../ui/KindBadge"
import { NoteProse } from "../ui/NoteProse"
import { PhoneHeader } from "../ui/PhoneHeader"
import { SaveButton } from "../ui/SaveButton"
import { ScaleToFit } from "../ui/ScaleToFit"
import { commandShortcut, isApplePlatform } from "../ui/shortcuts"
import { SourceLines, type SourcePart } from "../ui/SourceLines"
import { SplitPanes } from "../ui/SplitPanes"
import { TabLine, type TabLineItem } from "../ui/TabLine"
import { ViewSwitch, type EditorView } from "../ui/ViewSwitch"
import { DiagramInNote, phoneBleed } from "./c5Samples"
import { NOW, QUOTE, sampleThreads, useSampleThreads, type SampleThread } from "./commentSamples"
import { GuideGroup, GuideLabel, GuideValue } from "./parts"

// The Comments card: threads, the composer and the markers in their states,
// the panel's states, then put together as C5 would show them: the note in
// Split with the panel open, a drawing with its element pins, and the
// phone's sheet. No C5 board draws comments; these are drawn in its
// language: floating panels, the tokens, radii 7 to 14, the type scale and
// Lucide icons, on shadcn's Avatar, Badge, Button, Textarea, Collapsible,
// ScrollArea and Sheet.

const noop = () => {}

type ThreadsState = ReturnType<typeof useSampleThreads>

/** A sample thread as a CommentThread, answering its buttons. */
function threadElement(
  thread: SampleThread,
  state: ThreadsState,
  options: { active?: string; canWrite?: boolean; defaultReplying?: boolean; onSelect?: (id: string) => void } = {},
) {
  return (
    <CommentThread
      key={thread.id}
      anchor={thread.anchor}
      comments={thread.comments}
      resolved={thread.resolved}
      active={options.active === thread.id}
      canWrite={options.canWrite ?? true}
      defaultReplying={options.defaultReplying}
      onSelect={options.onSelect ? () => options.onSelect?.(thread.id) : undefined}
      now={NOW}
      {...state.handlers(thread)}
    />
  )
}

/** One live sample thread, with a way back once it has been changed. */
function SampleThreadDemo({
  thread,
  active,
  canWrite,
  defaultReplying,
}: {
  thread: SampleThread
  active?: boolean
  canWrite?: boolean
  defaultReplying?: boolean
}) {
  const state = useSampleThreads([thread])
  const current = state.all[0]
  return (
    <div className="flex w-full max-w-[300px] flex-col gap-2">
      {current ? (
        threadElement(current, state, { active: active ? current.id : undefined, canWrite, defaultReplying })
      ) : (
        <GuideValue>Thread deleted with its last comment.</GuideValue>
      )}
      {state.changed && (
        <Button variant="link" size="xs" className="self-start px-0" onClick={state.reset}>
          Reset the sample
        </Button>
      )}
    </div>
  )
}

const anchors: { anchor: CommentAnchorView; caption: string }[] = [
  { anchor: { kind: "text", quote: QUOTE }, caption: "text: the quote after an accent bar, two lines at most" },
  { anchor: { kind: "section", heading: "Steps" }, caption: "a section: its heading" },
  { anchor: { kind: "element", label: "Sign up" }, caption: "a drawing element: its label" },
  { anchor: { kind: "document" }, caption: "the whole file" },
]

function ThreadStates() {
  return (
    <div className="grid grid-cols-1 gap-7 lg:grid-cols-3">
      <div className="flex min-w-0 flex-col gap-3">
        <GuideLabel>Thread</GuideLabel>
        <SampleThreadDemo thread={sampleThreads.quote} />
        <GuideValue>
          Radius 12, padding 12, the panel border. Avatar 24, name 13/600, via agent on seg, when in 12 dim, edited. Your own comment's ... has Edit and Delete; the owner's has Delete on anyone's. Try Reply, Resolve and the menus.
        </GuideValue>
        <GuideLabel>Open in the file, replying</GuideLabel>
        <SampleThreadDemo thread={sampleThreads.steps} active defaultReplying />
        <GuideValue>The thread shown in the file takes a 1px accent-line border. Reply opens the composer; Cancel or Escape closes it and gives focus back to Reply.</GuideValue>
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        <GuideLabel>Context lines</GuideLabel>
        <div className="flex w-full max-w-[300px] flex-col gap-3">
          {anchors.map(({ anchor, caption }) => (
            <div key={caption} className="flex flex-col gap-1">
              <CommentAnchorLine anchor={anchor} onSelect={noop} />
              <GuideValue>{caption}</GuideValue>
            </div>
          ))}
        </div>
        <GuideValue>12.5px muted; a button that shows the anchor in the file.</GuideValue>
        <GuideLabel>Detached</GuideLabel>
        <SampleThreadDemo thread={sampleThreads.detached} />
        <SampleThreadDemo thread={sampleThreads.gone} />
        <GuideValue>The quote is kept when its text, heading or element is gone: struck through in dim, a dashed bar, and the badge says so.</GuideValue>
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        <GuideLabel>Resolved</GuideLabel>
        <SampleThreadDemo thread={sampleThreads.created} />
        <GuideValue>On the field fill, with who resolved it and when; Reopen brings it back.</GuideValue>
        <GuideLabel>Deleted comment, deleted account</GuideLabel>
        <SampleThreadDemo thread={sampleThreads.deleted} />
        <GuideValue>A deleted comment keeps its place while replies remain. A deleted account shows as such, with an empty figure.</GuideValue>
        <GuideLabel>Read only</GuideLabel>
        <SampleThreadDemo thread={sampleThreads.whole} canWrite={false} />
        <GuideValue>Viewers, and anyone offline: the words only, no Reply, Resolve or menus.</GuideValue>
      </div>
    </div>
  )
}

const LONG_DRAFT =
  "The steps skip what happens when the email link has expired. Say that a new link can be sent from the sign-in page, and that the old one stops working once a new one is sent. Invited people see the same."

/** A composer whose send fails, to show the message it keeps under the text. */
function FailingComposer() {
  return (
    <CommentComposer
      label="Reply, send fails"
      placeholder="Reply"
      submitLabel="Reply"
      defaultValue="Moved the diagram under Steps."
      error="Comments need a connection."
      onSubmit={() => Promise.reject(new Error("Comments need a connection."))}
      onCancel={noop}
    />
  )
}

function ComposerAndMarkers() {
  const [sent, setSent] = useState<string | null>(null)
  const apple = isApplePlatform()
  return (
    <div className="grid grid-cols-1 gap-7 lg:grid-cols-3">
      <div className="flex min-w-0 flex-col gap-3">
        <GuideLabel>Composer</GuideLabel>
        <div className="w-full max-w-[300px]">
          <CommentComposer
            label="Comment sample"
            onSubmit={async (body) => {
              await new Promise((resolve) => setTimeout(resolve, 450))
              setSent(body)
            }}
            onCancel={noop}
          />
        </div>
        <p aria-live="polite" className="leading-none">
          <GuideValue>{sent ? `Sent: ${sent}` : `Type, then ${apple ? "⌘↵" : "Ctrl ↵"} or Comment. Blank text can't be sent.`}</GuideValue>
        </p>
        <GuideLabel>Near and over the limit</GuideLabel>
        <div className="flex w-full max-w-[300px] flex-col gap-3">
          <CommentComposer label="Comment near the limit" defaultValue={LONG_DRAFT} maxLength={220} onSubmit={noop} onCancel={noop} />
          <CommentComposer label="Comment over the limit" defaultValue={`${LONG_DRAFT} Thanks!`} maxLength={200} onSubmit={noop} onCancel={noop} />
        </div>
        <GuideValue>The count shows from 90% of the limit, and the key leaves the button to make room; past it the count turns danger with the alert icon, and sending stops. Here the limit is about 200 to fit; comments take 5,000.</GuideValue>
        <GuideLabel>Failed, and offline</GuideLabel>
        <div className="flex w-full max-w-[300px] flex-col gap-3">
          <FailingComposer />
          <CommentComposer label="Comment, offline" onSubmit={noop} disabledReason="Comments need a connection." />
        </div>
        <GuideValue>A failed send keeps the text and says why, after the alert icon. Offline, the field is off.</GuideValue>
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        <GuideLabel>Markers</GuideLabel>
        <div className="flex flex-wrap items-center gap-3">
          <CommentMarker count={1} label="1 thread on line 3" />
          <CommentMarker count={2} label="2 threads on line 8" />
          <CommentMarker count={1} label="1 thread on Steps" active />
          <GuideValue>gutter · 2 threads · open</GuideValue>
        </div>
        <GuideValue>18 high, radius 5, 11px mono in accentSoft; the thread open in the panel in the accent, with an accent-line edge. Markers count threads, as the Comments button does, from 2.</GuideValue>
        <p className="max-w-[340px] text-[15.5px] leading-[1.6] text-body">
          <CommentHighlight>How a customer moves from sign-up</CommentHighlight> to their first project, and{" "}
          <CommentHighlight active>where agents help</CommentHighlight>.
        </p>
        <GuideValue>
          Commented text: a faint wash over a dotted 2px underline in the accent line (the accent, or accentSoftText where the accent is too light to see), apart from the selection and from links; the open thread&apos;s stronger, solid.
        </GuideValue>
        <DottedPage className="relative h-[120px] min-h-0 w-full max-w-[290px] overflow-hidden rounded-tile border border-border">
          <svg width="290" height="120" viewBox="0 0 290 120" aria-hidden="true" className="absolute top-0 left-0 font-[family-name:Excalifont,cursive]">
            <rect x="16" y="34" width="112" height="60" rx="14" className="fill-pastel-blue stroke-ink" strokeWidth="2" />
            <text x="72" y="70" textAnchor="middle" fontSize="20" className="fill-ink">
              Sign up
            </text>
            <ellipse cx="206" cy="68" rx="60" ry="30" className="fill-pastel-yellow stroke-ink" strokeWidth="2" />
            <text x="206" y="74" textAnchor="middle" fontSize="20" className="fill-ink">
              Project
            </text>
          </svg>
          <CommentMarker variant="element" count={2} label="2 threads on Sign up" className="absolute top-[34px] left-[128px] -translate-y-full" />
          <CommentMarker variant="element" count={1} active label="1 thread on Project" className="absolute top-[46px] left-[248px] -translate-y-full" />
        </DottedPage>
        <GuideValue>Pins on a drawing: 24, the accent with an accent-line edge, a panel ring; the point is the bottom-left corner. One thread shows the icon; the open one grows to 28 with an accentSoft ring.</GuideValue>
        <GuideLabel>Comment button</GuideLabel>
        <div className="flex flex-wrap items-center gap-3">
          <CommentActionButton />
          <CommentActionButton size="touch" />
        </div>
        <GuideValue>Over a selection or a selected element, on an island: 32 high, 40 on phones.</GuideValue>
        <GuideLabel>Comments button</GuideLabel>
        <div className="flex flex-wrap items-center gap-3">
          <CommentsButton count={3} />
          <CommentsButton count={3} pressed />
          <CommentsButton count={0} />
          <CommentsButton count={3} size="touch" />
        </div>
        <GuideValue>In the editor&apos;s header with the open count, seg while the panel is open; the phone&apos;s round button.</GuideValue>
        <GuideLabel>Detached badge</GuideLabel>
        <div className="flex items-center gap-2">
          <DetachedBadge />
          <GuideValue>warnBg with warnText, the unlink icon</GuideValue>
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        <GuideLabel>New comment</GuideLabel>
        <div className="w-full max-w-[300px]">
          <CommentDraft anchor={{ kind: "text", quote: "Connect an agent." }} onSubmit={noop} onCancel={noop} autoFocus={false} />
        </div>
        <GuideValue>A thread being written, from Comment: a 1px accent-line border, what it will be on, the composer.</GuideValue>
        <div className="w-full max-w-[300px]">
          <CommentDraft anchor={{ kind: "document", label: "Whole drawing" }} onSubmit={noop} onCancel={noop} autoFocus={false} />
        </div>
        <GuideValue>On the whole file, from the panel&apos;s new-comment button.</GuideValue>
      </div>
    </div>
  )
}

/** A panel sample with its caption, 460 high. */
function PanelSample({ label, caption, children }: { label: string; caption: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <GuideLabel>{label}</GuideLabel>
      <div className="h-[460px]">{children}</div>
      <GuideValue>{caption}</GuideValue>
    </div>
  )
}

function PanelStates() {
  const live = useSampleThreads([sampleThreads.quote, sampleThreads.steps, sampleThreads.created])
  const [active, setActive] = useState<string>(sampleThreads.quote.id)
  const [draft, setDraft] = useState(false)
  const offline = [sampleThreads.quote, sampleThreads.steps]
  const readOnly = [sampleThreads.steps, sampleThreads.whole, sampleThreads.created]
  const staticState = useSampleThreads([...readOnly])
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,320px),1fr))] gap-7">
      <PanelSample label="With threads" caption="The open count in the header; OPEN, then RESOLVED folded. Resolve moves a thread down; the + starts one on the whole note.">
        <CommentsPanel
          headingLevel={4}
          className="h-full"
          announcement={live.announcement}
          openThreads={live.open.map((thread) => threadElement(thread, live, { active, onSelect: setActive }))}
          resolvedThreads={live.resolved.map((thread) => threadElement(thread, live))}
          draft={
            draft && (
              <CommentDraft
                anchor={{ kind: "document" }}
                autoFocus
                onSubmit={async () => {
                  await new Promise((resolve) => setTimeout(resolve, 450))
                  setDraft(false)
                }}
                onCancel={() => setDraft(false)}
              />
            )
          }
          onCommentOnFile={() => setDraft(true)}
          onClose={noop}
        />
      </PanelSample>
      <PanelSample label="Empty" caption="Where to start, and the whole-note action.">
        <CommentsPanel headingLevel={4} className="h-full" openThreads={[]} onCommentOnFile={noop} onClose={noop} />
      </PanelSample>
      <PanelSample label="Loading" caption="The loading line under the header, and two thread shapes.">
        <CommentsPanel headingLevel={4} className="h-full" openThreads={[]} status="loading" onClose={noop} />
      </PanelSample>
      <PanelSample label="Needs a connection" caption="Opened offline, before any list loaded: nothing is kept on the device.">
        <CommentsPanel headingLevel={4} className="h-full" openThreads={[]} status="offline" onClose={noop} />
      </PanelSample>
      <PanelSample label="Offline, earlier list" caption="The list loaded earlier stays, read only, under a banner.">
        <CommentsPanel
          headingLevel={4}
          className="h-full"
          status="offline"
          openThreads={offline.map((thread) => threadElement(thread, staticState, { canWrite: false }))}
          onClose={noop}
        />
      </PanelSample>
      <PanelSample label="Viewer" caption="Viewers read every thread; the foot says why they can't write.">
        <CommentsPanel
          headingLevel={4}
          className="h-full"
          readOnly
          openThreads={staticState.open.map((thread) => threadElement(thread, staticState, { canWrite: false }))}
          resolvedThreads={staticState.resolved.map((thread) => threadElement(thread, staticState, { canWrite: false }))}
          onCommentOnFile={noop}
          onClose={noop}
        />
      </PanelSample>
      <PanelSample label="Did not load" caption="A failed first load, with Try again.">
        <CommentsPanel headingLevel={4} className="h-full" openThreads={[]} status="error" onRetry={noop} onClose={noop} />
      </PanelSample>
    </div>
  )
}

// customer-model.mdx as C5 screen 1 shows it, the commented quote marked.
const NOTE_SOURCE = (active: boolean): readonly (readonly SourcePart[])[] => [
  [["dim", "---"]],
  [["key", "title"], ": ", ["str", "Customer model"]],
  [["dim", "---"]],
  [["kw", "import"], " { Callout } ", ["kw", "from"], " ", ["str", '"workspace:components/callout.mdx"']],
  [],
  [["head", "# Customer model"]],
  [],
  [<CommentHighlight active={active}>{QUOTE}</CommentHighlight>, ", and where agents help."],
  [],
  [["key", "<Callout"], " tone=", ["str", '"note"'], ["key", ">"]],
  ["  Agents act as the signed-in person in every project they can open."],
  [["key", "</Callout>"]],
  [],
  [["head", "## Steps"]],
  [],
  [["kw", "1."], " Sign up with an email link."],
  [["kw", "2."], " Create a project."],
  [["kw", "3."], " Connect an agent."],
  [],
  [["key", "<Diagram"], " src=", ["str", '"flows/signup.d2"'], " ", ["key", "/>"]],
]

const OPEN_FILES = ["docs/customer-model.mdx", "art/flow.excalidraw", "flows/signup.d2", "docs/pricing.md", "docs/onboarding.mdx"]

const tabItems: TabLineItem[] = OPEN_FILES.map((path) => ({
  value: path,
  name: path.split("/").pop() ?? path,
  badge: <KindBadge kind={path.endsWith(".mdx") || path.endsWith(".md") ? "note" : path.endsWith(".d2") ? "diagram" : "drawing"} />,
  label: path,
}))

/**
 * C5 screen 1 with the comments open, the explorer hidden (⌘B): the editor
 * in Split beside the panel, 16 apart on the dotted page. The quote's thread
 * is open: its text is marked in both panes and its thread outlined.
 */
function SplitWithComments() {
  const state = useSampleThreads([sampleThreads.quote, sampleThreads.steps, sampleThreads.whole, sampleThreads.detached, sampleThreads.created])
  const [active, setActive] = useState<string | null>(sampleThreads.quote.id)
  const [view, setView] = useState<EditorView>("split")
  const [panel, setPanel] = useState(true)
  const commentsButton = useRef<HTMLButtonElement>(null)
  const [tab, setTab] = useState<string | null>(OPEN_FILES[0])
  const focus = commandShortcut(".", isApplePlatform())
  const quoteOpen = active === sampleThreads.quote.id
  const stepsOpen = active === sampleThreads.steps.id
  const openCount = state.open.length
  const quoteMarker = <CommentMarker count={1} label="1 thread on this text" active={quoteOpen} onClick={() => setActive(sampleThreads.quote.id)} />
  const stepsMarker = <CommentMarker count={1} label="1 thread on Steps" active={stepsOpen} onClick={() => setActive(sampleThreads.steps.id)} />
  const source = (
    <SourceLines
      aria-label="customer-model.mdx, source, with comments"
      lines={NOTE_SOURCE(quoteOpen)}
      markers={{ 8: quoteMarker, 14: stepsMarker }}
      className="h-full overflow-hidden"
    />
  )
  const rendered = (
    <NoteProse aria-label="customer-model.mdx, rendered, with comments" className="h-full overflow-hidden">
      <h1>Customer model</h1>
      <div className="relative">
        <p>
          <CommentHighlight active={quoteOpen}>{QUOTE}</CommentHighlight>, and where agents help.
        </p>
        <span className="absolute top-1 -right-9">{quoteMarker}</span>
      </div>
      <Callout icon={<Info aria-hidden="true" />}>Agents act as the signed-in person in every project they can open.</Callout>
      <div className="relative">
        <h2>Steps</h2>
        <span className="absolute top-3 -right-9">{stepsMarker}</span>
      </div>
      <ol>
        <li>Sign up with an email link.</li>
        <li>Create a project.</li>
        <li>Connect an agent.</li>
      </ol>
      <figure className="flex h-[150px] items-center justify-center rounded-tile border border-border bg-(--bg) bg-[radial-gradient(var(--dot)_1px,transparent_1.4px)] bg-size-[22px_22px]">
        <DiagramInNote />
      </figure>
    </NoteProse>
  )
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <GuideLabel>C5 note in Split, comments open</GuideLabel>
      <ScaleToFit width={1440} className="overflow-hidden rounded-[4px]">
        <DottedPage className="flex h-[900px] min-h-0 gap-4 p-4">
          <FloatingPanel className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <EditorHeader>
              <TabLine aria-label="Open files, with comments" items={tabItems} value={tab} onValueChange={setTab} />
              <ViewSwitch value={view} onValueChange={setView} />
              <CommentsButton ref={commentsButton} count={openCount} pressed={panel} onClick={() => setPanel((shown) => !shown)} />
              <IconButton label="Focus" shortcut={focus.label} keyShortcuts={focus.aria}>
                <Maximize2 />
              </IconButton>
            </EditorHeader>
            <div className="min-h-0 flex-1">
              {view === "split" ? (
                <SplitPanes aria-label="Resize the source and the rendered note, with comments" startSize="46%" start={source} end={rendered} />
              ) : view === "source" ? (
                source
              ) : (
                rendered
              )}
            </div>
          </FloatingPanel>
          {panel && (
            // Level 3: it follows the rendered note's h2 (Steps).
            <CommentsPanel
              headingLevel={3}
              className="h-full shrink-0"
              announcement={state.announcement}
              openThreads={state.open.map((thread) => threadElement(thread, state, { active: active ?? undefined, onSelect: setActive }))}
              resolvedThreads={state.resolved.map((thread) => threadElement(thread, state))}
              onCommentOnFile={noop}
              onClose={() => {
                setPanel(false)
                commentsButton.current?.focus()
              }}
            />
          )}
        </DottedPage>
      </ScaleToFit>
      <GuideValue>
        The panel is 320 wide beside the editor, 16 apart, the same floating panel as the files. Pick a thread&apos;s quote or a marker to open it; the comments button in the header shows and hides the panel.
      </GuideValue>
    </div>
  )
}

/** C5's drawing, full screen, with pins on the commented elements and a new comment on the selected one. */
function DrawingWithComments() {
  const state = useSampleThreads([sampleThreads.signUp, sampleThreads.agent, sampleThreads.gone])
  const [active, setActive] = useState<string | null>(null)
  const [draft, setDraft] = useState(true)
  const [view, setView] = useState<EditorView>("rendered")
  const [tool, setTool] = useState("select")
  const focus = commandShortcut(".", isApplePlatform())
  const draftAnchor: CommentAnchorView = { kind: "element", label: "Invite a teammate" }
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <GuideLabel>C5 drawing, full screen, comments open</GuideLabel>
      <ScaleToFit width={1440} className="overflow-hidden rounded-[4px]">
        <DottedPage className="relative h-[900px] min-h-0 overflow-hidden">
          <svg
            width="1440"
            height="900"
            viewBox="0 0 1440 900"
            aria-label="Drawing sample with comments: sign-up flow sketch"
            className="absolute top-0 left-0 font-[family-name:Excalifont,cursive]"
          >
            <rect x="120" y="170" width="220" height="110" rx="18" className="fill-pastel-pink stroke-ink" strokeWidth="2" />
            <text x="230" y="232" textAnchor="middle" fontSize="26" className="fill-ink">
              Landing page
            </text>
            <path d="M342 226 C 400 250, 430 300, 470 332" fill="none" className="stroke-ink" strokeWidth="2" strokeLinecap="round" />
            <path d="M458 330 L471 333 L466 320" fill="none" className="stroke-ink" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            <rect x="470" y="310" width="200" height="100" rx="18" className="fill-pastel-blue stroke-ink" strokeWidth="2" />
            <text x="570" y="368" textAnchor="middle" fontSize="26" className="fill-ink">
              Sign up
            </text>
            <ellipse cx="880" cy="360" rx="110" ry="60" className="fill-pastel-yellow stroke-ink" strokeWidth="2" />
            <text x="880" y="368" textAnchor="middle" fontSize="26" className="fill-ink">
              Project
            </text>
            <path d="M672 358 C 720 350, 740 352, 766 358" fill="none" className="stroke-ink" strokeWidth="2" strokeLinecap="round" />
            <path d="M756 350 L768 358 L756 366" fill="none" className="stroke-ink" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M768 540 L858 480 L948 540 L858 600 Z" className="fill-pastel-green stroke-ink" strokeWidth="2" strokeLinejoin="round" />
            <text x="858" y="548" textAnchor="middle" fontSize="22" className="fill-ink">
              Agent?
            </text>
            <path d="M880 422 C 876 445, 868 460, 862 478" fill="none" className="stroke-ink" strokeWidth="2" strokeLinecap="round" />
            <path d="M853 470 L861 480 L870 471" fill="none" className="stroke-ink" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            <rect x="420" y="630" width="240" height="110" rx="18" className="fill-pastel-blue stroke-ink" strokeWidth="2" />
            <text x="540" y="692" textAnchor="middle" fontSize="22" className="fill-ink">
              Invite a teammate
            </text>
            <path d="M790 560 C 740 600, 700 630, 664 660" fill="none" className="stroke-ink" strokeWidth="2" strokeLinecap="round" />
            <path d="M668 648 L662 662 L676 660" fill="none" className="stroke-ink" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            {/* The selected element, as the canvas marks a selection: an accent box with handles. */}
            <g className="fill-none stroke-primary" strokeWidth="1.5">
              <rect x="412" y="622" width="256" height="126" rx="4" />
              {[
                [412, 622],
                [668, 622],
                [412, 748],
                [668, 748],
              ].map(([x, y]) => (
                <rect key={`${x}-${y}`} x={x - 4} y={y - 4} width="8" height="8" rx="2" className="fill-panel" />
              ))}
            </g>
          </svg>
          <CommentMarker
            variant="element"
            count={1}
            label="1 thread on Sign up"
            active={active === sampleThreads.signUp.id}
            onClick={() => setActive(sampleThreads.signUp.id)}
            className="absolute top-[312px] left-[662px] -translate-y-full"
          />
          <CommentMarker
            variant="element"
            count={1}
            label="1 thread on Agent?"
            active={active === sampleThreads.agent.id}
            onClick={() => setActive(sampleThreads.agent.id)}
            className="absolute top-[512px] left-[906px] -translate-y-full"
          />
          {!draft && (
            <CommentActionButton onClick={() => setDraft(true)} className="absolute top-[572px] left-[540px] -translate-x-1/2" />
          )}
          <CanvasIsland className="absolute top-4 left-[calc((100%-352px)/2)] -translate-x-1/2">
            <ToolGroup value={tool} onValueChange={setTool} aria-label="Drawing tools, with comments">
              {islandTools.default.map((candidate) => (
                <ToolButton key={candidate.id} tool={candidate} />
              ))}
            </ToolGroup>
          </CanvasIsland>
          <EditorHeader variant="floating" className="absolute top-4 right-4">
            <ViewSwitch value={view} onValueChange={setView} names="canvas" />
            <CommentsButton count={state.open.length} pressed />
            <SaveButton />
            <IconButton label="Exit full screen" shortcut={focus.label} keyShortcuts={focus.aria}>
              <Minimize2 />
            </IconButton>
          </EditorHeader>
          <CommentsPanel
            headingLevel={4}
            fileNoun="drawing"
            className="absolute top-[76px] right-4 bottom-4"
            announcement={state.announcement}
            draft={
              draft && (
                <CommentDraft
                  anchor={draftAnchor}
                  autoFocus={false}
                  onSubmit={async () => {
                    await new Promise((resolve) => setTimeout(resolve, 450))
                    setDraft(false)
                  }}
                  onCancel={() => setDraft(false)}
                />
              )
            }
            openThreads={state.open.map((thread) => threadElement(thread, state, { active: active ?? undefined, onSelect: setActive }))}
            resolvedThreads={state.resolved.map((thread) => threadElement(thread, state))}
            onCommentOnFile={noop}
            onClose={noop}
          />
          <ZoomControl zoom={1} onZoomOut={noop} onZoomIn={noop} onReset={noop} className="absolute bottom-4 left-4" />
        </DottedPage>
      </ScaleToFit>
      <GuideValue>
        Pins sit at an element&apos;s top-right corner, or at the spot a comment marks; the tools centre in the space left of the panel. The selected element has the Comment button above it (Cancel the new comment to see it); the panel starts the comment on it.
      </GuideValue>
    </div>
  )
}

/** The phone's note (390 by 844) with the comments sheet open over its lower part, as a picture: the live one opens from the button below. */
function PhoneSheet() {
  const [frame, setFrame] = useState<HTMLDivElement | null>(null)
  const pictured = useSampleThreads([sampleThreads.quote, sampleThreads.steps, sampleThreads.created])
  const live = useSampleThreads([sampleThreads.quote, sampleThreads.steps, sampleThreads.whole, sampleThreads.created])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState<string>(sampleThreads.quote.id)
  return (
    <div className="flex w-full max-w-[390px] flex-col gap-3">
      <GuideLabel>Phone, comments sheet</GuideLabel>
      <div inert className={cn("relative h-[844px] w-full max-w-[390px] overflow-hidden rounded-panel border border-border bg-panel", phoneBleed)}>
        <PhoneHeader
          back={
            <RoundIconButton label="Back to files and projects">
              <ChevronLeft />
            </RoundIconButton>
          }
        >
          <CommentsButton size="touch" count={2} pressed />
          <RoundIconButton label="File actions">
            <MoreHorizontal />
          </RoundIconButton>
        </PhoneHeader>
        <div className="absolute inset-x-0 top-16 flex flex-col gap-3.5 px-[22px]">
          <p className="text-[30px] leading-[1.15] font-bold">Customer model</p>
          <p className="text-[15.5px] leading-[1.6] text-body">
            <CommentHighlight active>{QUOTE}</CommentHighlight>, and where agents help.
          </p>
          <Callout className="text-[15px] leading-[1.55]">Agents act as the signed-in person in every project they can open.</Callout>
          <p className="flex items-center justify-between text-[21px] font-semibold">
            Steps
            <CommentMarker count={1} label="1 thread on Steps, phone sample" />
          </p>
        </div>
        <div ref={setFrame} className="absolute inset-0" />
        {frame && (
          <CommentsSheet
            open
            inert
            modal={false}
            onOpenChange={noop}
            container={frame}
            className="absolute data-[side=bottom]:h-[560px]"
            overlayClassName="absolute"
            openThreads={pictured.open.map((thread) => threadElement(thread, pictured, { active: sampleThreads.quote.id }))}
            resolvedThreads={pictured.resolved.map((thread) => threadElement(thread, pictured))}
            onCommentOnFile={noop}
          />
        )}
      </div>
      <GuideValue>
        shadcn&apos;s Sheet from the bottom, 75% of the screen, radius 14 at the top with a grab bar. 15px text; Resolve, the menus, Reply and Close are 40. Close takes focus when it opens; a thread&apos;s Go to closes the sheet so the text shows.
      </GuideValue>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" className="pointer-coarse:h-10" onClick={() => setOpen(true)}>
          Open the comments sheet
        </Button>
        <GuideValue>The live sheet, over this page</GuideValue>
      </div>
      <CommentsSheet
        open={open}
        onOpenChange={setOpen}
        announcement={live.announcement}
        openThreads={live.open.map((thread) =>
          threadElement(thread, live, {
            active,
            onSelect: (id) => {
              setActive(id)
              setOpen(false)
            },
          }),
        )}
        resolvedThreads={live.resolved.map((thread) => threadElement(thread, live))}
        onCommentOnFile={noop}
      />
    </div>
  )
}

export function CommentsSection() {
  // The drawing samples use the drawing font, which loads on demand.
  useEffect(() => {
    ensureGeneratedNativeFont().catch(() => {
      /* The samples fall back to a cursive font. */
    })
  }, [])
  return (
    <>
      <GuideGroup title="Comment threads">
        <ThreadStates />
      </GuideGroup>
      <GuideGroup title="Composer and markers">
        <ComposerAndMarkers />
      </GuideGroup>
      <GuideGroup title="Comments panel">
        <PanelStates />
      </GuideGroup>
      <GuideGroup title="Comments in the C5 screens">
        <div className="flex flex-col gap-7">
          <SplitWithComments />
          <DrawingWithComments />
          <PhoneSheet />
        </div>
      </GuideGroup>
    </>
  )
}
