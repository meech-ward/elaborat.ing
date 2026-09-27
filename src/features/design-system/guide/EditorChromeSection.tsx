import { useState } from "react"
import { ChevronLeft, Info, Maximize2, Minimize2, MoreHorizontal, Save } from "lucide-react"
import { DottedPage } from "@/components/panel"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import { ActionMenu, type MenuEntry } from "../ui/ActionMenu"
import { Callout } from "../ui/Banner"
import { EditorHeader } from "../ui/EditorHeader"
import { EditorTab, EditorTabGhost } from "../ui/EditorTab"
import { FloatingPanel } from "../ui/FloatingPanel"
import { IconButton, RoundIconButton } from "../ui/IconButton"
import { KindBadge, type FileKind } from "../ui/KindBadge"
import { NoteProse } from "../ui/NoteProse"
import { PhoneHeader } from "../ui/PhoneHeader"
import { SaveButton } from "../ui/SaveButton"
import { ScaleToFit } from "../ui/ScaleToFit"
import { commandShortcut, isApplePlatform } from "../ui/shortcuts"
import { SourceLines, type SourcePart } from "../ui/SourceLines"
import { SplitPanes } from "../ui/SplitPanes"
import { TabLine, type TabLineItem } from "../ui/TabLine"
import { ViewSwitch, type EditorView } from "../ui/ViewSwitch"
import { C5FocusHeader, DiagramInNote, phoneBleed } from "./c5Samples"
import { GuideGroup, GuideLabel, GuideValue } from "./parts"

// The Editor chrome group: the open-file tabs, the view switch, Save and the
// icon buttons, each in its states, then assembled as the C5 screens use
// them: the note in Split (the top line over the source and the rendered
// note), the focus mode header and the phone header.

// A state drawn on a tab that does not have it, to show it: the pointer over
// it (its fill and the close mark) and keyboard focus (the inset ring).
const SHOWN_HOVER = "bg-(--tab-fill) text-foreground [&_[data-slot=tab-close]]:opacity-100"
const SHOWN_FOCUS = "outline-2 -outline-offset-2 outline-solid outline-ring"

const kindOf = (path: string): FileKind =>
  /\.mdx?$/.test(path) ? "note" : path.endsWith(".excalidraw") ? "drawing" : path.endsWith(".d2") ? "diagram" : "text"

const fileName = (path: string) => path.split("/").pop() ?? path

function tabItem(path: string, dirty: ReadonlySet<string>): TabLineItem {
  return {
    value: path,
    name: fileName(path),
    badge: <KindBadge kind={kindOf(path)} />,
    dirty: dirty.has(path),
    label: path,
    detail: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : undefined,
  }
}

/**
 * A tab's file actions, as the editor offers them: Save while it has unsaved
 * edits, Duplicate with this platform's key, Reload, Export and Format.
 */
function tabActions(dirty: boolean, save: () => void): MenuEntry[] {
  const duplicate = commandShortcut("D", isApplePlatform())
  return [
    { label: "Save", disabled: !dirty, onSelect: save },
    { label: "Duplicate", shortcut: duplicate.label, keyShortcuts: duplicate.aria, onSelect: () => {} },
    { label: "Reload", onSelect: () => {} },
    { label: "Export", onSelect: () => {} },
    { label: "Format", onSelect: () => {} },
  ]
}

// The C5 screen's open files: six fit the desktop line, "+4" lists the rest.
const OPEN_FILES = [
  "docs/customer-model.mdx",
  "art/flow.excalidraw",
  "flows/signup.d2",
  "docs/pricing.md",
  "docs/onboarding.mdx",
  "docs/roadmap.md",
  "flows/billing.d2",
  "README.md",
  "docs/agents.mdx",
  "art/sketch.excalidraw",
]

// customer-model.mdx as C5 screen 1 shows it, coloured as the editor colours it.
const NOTE_SOURCE: readonly (readonly SourcePart[])[] = [
  [["dim", "---"]],
  [["key", "title"], ": ", ["str", "Customer model"]],
  [["dim", "---"]],
  [["kw", "import"], " { Callout } ", ["kw", "from"], " ", ["str", '"workspace:components/callout.mdx"']],
  [],
  [["head", "# Customer model"]],
  [],
  ["How a customer moves from sign-up to their first project, and where agents help."],
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
  [],
  [["key", "<Drawing"], " src=", ["str", '"art/flow.excalidraw"'], " ", ["key", "/>"]],
]

export function EditorChromeSection() {
  return (
    <GuideGroup title="Editor chrome">
      <div className="flex flex-col gap-7">
        <div className="grid grid-cols-1 gap-7 lg:grid-cols-3">
          <div className="flex min-w-0 flex-col gap-3">
            <TabsDemo />
          </div>
          <div className="flex min-w-0 flex-col gap-3">
            <ViewSwitchDemo />
          </div>
          <div className="flex min-w-0 flex-col gap-3">
            <ButtonsDemo />
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          <DesktopTopLine />
        </div>
        <div className="grid grid-cols-1 gap-7 lg:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-3">
            <FocusHeader />
          </div>
          <div className="flex min-w-0 flex-col gap-3">
            <PhoneHeaderDemo />
          </div>
        </div>
      </div>
    </GuideGroup>
  )
}

function TabsDemo() {
  const [overflowActive, setOverflowActive] = useState<string | null>(OPEN_FILES[0])
  const noDirty = new Set<string>()
  return (
    <>
      <GuideLabel>Tabs</GuideLabel>
      {/* The states side by side, held still: inert, so they neither take
          focus nor react to the pointer. The top line below has live ones. */}
      <div inert>
        <Tabs value="notes.mdx" className="contents">
          <TabsList aria-label="Tab states" className="flex flex-wrap items-center gap-0.5">
            <EditorTab value="notes.mdx" name="notes.mdx" badge={<KindBadge kind="note" />} dirty onClose={() => {}} />
            <EditorTab value="flow" name="flow" badge={<KindBadge kind="drawing" />} onClose={() => {}} />
            <EditorTab value="signup" name="signup" badge={<KindBadge kind="diagram" />} onClose={() => {}} className={SHOWN_HOVER} />
            <EditorTab value="pricing.md" name="pricing.md" badge={<KindBadge kind="note" />} onClose={() => {}} className={SHOWN_FOCUS} />
          </TabsList>
        </Tabs>
      </div>
      <GuideValue>Active and unsaved · open · pointer over it, with close · keyboard focus</GuideValue>
      <GuideValue>32 high, radius 9, 13px 500 muted; active on seg at 600; Delete closes the focused tab</GuideValue>
      <GuideLabel>Dragged</GuideLabel>
      <div className="flex">
        <EditorTabGhost name="flow" badge={<KindBadge kind="drawing" />} className="static" />
      </div>
      <GuideValue>A tab on its way to a new place follows the pointer, raised with the panel shadow</GuideValue>
      <GuideLabel>Overflow</GuideLabel>
      <div className="max-w-[340px] rounded-button border border-dashed border-panel-border px-1.5 py-[7px]">
        <TabLine
          aria-label="Open files, narrow"
          items={OPEN_FILES.map((path) => tabItem(path, noDirty))}
          value={overflowActive}
          onValueChange={setOverflowActive}
        />
      </div>
      <GuideValue>Tabs that don't fit are listed under +N; picking one brings it into view</GuideValue>
    </>
  )
}

function ViewSwitchDemo() {
  const [view, setView] = useState<EditorView>("split")
  const [phoneView, setPhoneView] = useState<EditorView>("rendered")
  const label = { source: "Source", split: "Split", rendered: "Rendered" }[view]
  return (
    <>
      <GuideLabel>View switch</GuideLabel>
      <div className="flex flex-wrap items-center gap-3">
        <ViewSwitch value={view} onValueChange={setView} />
        <GuideValue>{label} is on</GuideValue>
      </div>
      <GuideValue>32 by 28 on a seg track, padding 2, gap 2; the view that is on sits on the panel with a ring</GuideValue>
      <GuideValue>Point at a view for its name and key: ⌘⌥1 to 3, Ctrl+Alt+1 to 3 off Apple</GuideValue>
      <GuideLabel>Each view on</GuideLabel>
      <div className="flex flex-wrap items-center gap-3" inert>
        <ViewSwitch aria-label="Source on" value="source" onValueChange={() => {}} />
        <ViewSwitch aria-label="Split on" value="split" onValueChange={() => {}} />
        <ViewSwitch aria-label="Rendered on" value="rendered" onValueChange={() => {}} />
      </div>
      <GuideLabel>Phones: no Split</GuideLabel>
      <div className="flex flex-wrap items-center gap-3">
        <ViewSwitch aria-label="View, phone" views={["source", "rendered"]} value={phoneView} onValueChange={setPhoneView} />
        <ViewSwitch aria-label="View, disabled" value="rendered" onValueChange={() => {}} disabled />
        <GuideValue>and disabled</GuideValue>
      </div>
      <div className="flex flex-wrap items-center gap-3 rounded-button bg-(--bg) p-3">
        <ViewSwitch aria-label="View, floating" floating views={["source", "rendered"]} value={phoneView} onValueChange={setPhoneView} />
        <GuideValue>floating over the file, beside the round buttons</GuideValue>
      </div>
    </>
  )
}

function ButtonsDemo() {
  const apple = isApplePlatform()
  const focus = commandShortcut(".", apple)
  return (
    <>
      <GuideLabel>Save</GuideLabel>
      <div className="flex flex-wrap items-center gap-2.5">
        <SaveButton />
        <SaveButton disabled />
      </div>
      <GuideValue>30 high, padding 12, gap 8; the key follows the platform; disabled with nothing to save</GuideValue>
      <GuideLabel>Icon buttons</GuideLabel>
      <div className="flex flex-wrap items-center gap-1">
        <IconButton label="Focus" shortcut={focus.label} keyShortcuts={focus.aria}>
          <Maximize2 />
        </IconButton>
        <IconButton label="Exit full screen" shortcut={focus.label} keyShortcuts={focus.aria}>
          <Minimize2 />
        </IconButton>
        <IconButton label="Focus, disabled" disabled>
          <Maximize2 />
        </IconButton>
      </div>
      <GuideValue>30, radius 8, muted; the tooltip names it with its key</GuideValue>
      <GuideLabel>Phone round buttons</GuideLabel>
      <div className="flex flex-wrap items-center gap-3">
        <RoundIconButton label="Back to files and projects">
          <ChevronLeft />
        </RoundIconButton>
        <RoundIconButton label="Save">
          <Save />
        </RoundIconButton>
        <RoundIconButton label="Save" dirty>
          <Save />
        </RoundIconButton>
      </div>
      <GuideValue>40 round on the panel, 20px icon; the 8px dot is unsaved</GuideValue>
    </>
  )
}

/** customer-model.mdx rendered: the note's type, the callout with its icon, the steps and the diagram. */
function RenderedNote() {
  return (
    <NoteProse aria-label="customer-model.mdx, rendered" className="h-full overflow-hidden">
      <h1>Customer model</h1>
      <p>How a customer moves from sign-up to their first project, and where agents help.</p>
      <Callout icon={<Info aria-hidden="true" />}>Agents act as the signed-in person in every project they can open.</Callout>
      <h2>Steps</h2>
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
}

/** The editor's body in each view: the source, both side by side, or the rendered note. */
function NoteBody({ view }: { view: EditorView }) {
  const source = <SourceLines aria-label="customer-model.mdx, source" lines={NOTE_SOURCE} currentLine={22} className="h-full overflow-hidden" />
  if (view === "source") return source
  if (view === "rendered") return <RenderedNote />
  // As C5 draws it: the two panes share the width and the rendered one adds its padding, so the source takes 523 of 1126.
  return <SplitPanes aria-label="Resize the source and the rendered note" startSize="46.45%" start={source} end={<RenderedNote />} />
}

/**
 * C5 screen 1's editor: the top line (the open files, the view switch, Save
 * and Focus) over customer-model.mdx in the view that is on.
 */
function DesktopTopLine() {
  const [open, setOpen] = useState<readonly string[]>(OPEN_FILES)
  const [active, setActive] = useState<string | null>(OPEN_FILES[0])
  const [dirty, setDirty] = useState<ReadonlySet<string>>(() => new Set([OPEN_FILES[0]]))
  const [view, setView] = useState<EditorView>("split")
  const focus = commandShortcut(".", isApplePlatform())

  const close = (path: string) => {
    const index = open.indexOf(path)
    const next = open.filter((entry) => entry !== path)
    setOpen(next)
    if (path === active) setActive(next[Math.min(index, next.length - 1)] ?? null)
  }
  const saveFile = (path: string) => {
    const next = new Set(dirty)
    next.delete(path)
    setDirty(next)
  }

  return (
    <>
      <GuideLabel>C5 note in Split</GuideLabel>
      {/* The editor 1128 wide, as on the 1440 screen: a narrower page shows it whole, scaled down. */}
      <ScaleToFit width={1128}>
        <FloatingPanel className="overflow-hidden">
          <EditorHeader>
            <TabLine
              items={open.map((path) => tabItem(path, dirty))}
              value={active}
              onValueChange={setActive}
              onClose={close}
              actions={(path) => tabActions(dirty.has(path), () => saveFile(path))}
            />
            <ViewSwitch value={view} onValueChange={setView} />
            {active && dirty.has(active) && <SaveButton onClick={() => saveFile(active)} />}
            <IconButton label="Focus" shortcut={focus.label} keyShortcuts={focus.aria}>
              <Maximize2 />
            </IconButton>
          </EditorHeader>
          <div className="h-[580px]">
            <NoteBody view={view} />
          </div>
        </FloatingPanel>
      </ScaleToFit>
      <GuideValue>
        Source: 13 on 22 in the code font, numbers in faint, the current line in lineHi. Split: a 1px divider that turns accent under the pointer or with focus (arrow keys move it). Rendered: H1 32, body 15.5 on 1.6 in a 680 column, the callout with its icon.
      </GuideValue>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <GuideValue>
          Live: pick, close (point at a tab, or Delete) and save tabs, and switch the view; the body stays customer-model.mdx. Save shows while the file has unsaved edits. A tab's file actions open on right-click, or from ... at the active tab's end (point at it, or Tab from it). 1128 wide, as on the 1440 screen
        </GuideValue>
        {open.length < OPEN_FILES.length && (
          <Button
            variant="link"
            size="xs"
            className="px-0"
            onClick={() => {
              setOpen(OPEN_FILES)
              setActive(OPEN_FILES[0])
            }}
          >
            Reopen the closed files
          </Button>
        )}
      </div>
    </>
  )
}

/** C5 screens 4 and 5: a drawing or diagram full screen, the header floats at the top right. */
function FocusHeader() {
  return (
    <>
      <GuideLabel>Focus mode header</GuideLabel>
      <DottedPage className="relative h-[92px] min-h-0 overflow-hidden rounded-panel border border-border">
        <C5FocusHeader names="canvas" className="absolute top-4 right-4" />
      </DottedPage>
      <GuideValue>44 high, radius 12, padding 6, gap 6, the panel shadow; 16 from the top and right. A drawing's or diagram's views are Code, Split and Canvas</GuideValue>
    </>
  )
}

/**
 * The phone note's header: Back at the top left; the view switch, the file's
 * actions and, while there are unsaved edits, Save with its dot at the top
 * right. (C5 draws Back and Save; the switch and the actions keep the
 * desktop's controls in reach.)
 */
function PhoneHeaderDemo() {
  const [dirty, setDirty] = useState(true)
  const [view, setView] = useState<EditorView>("rendered")
  return (
    <>
      <GuideLabel>Phone header</GuideLabel>
      <div className={cn("relative h-[124px] w-full max-w-[390px] overflow-hidden rounded-panel border border-border bg-panel", phoneBleed)}>
        <PhoneHeader
          back={
            <RoundIconButton label="Back to files and projects">
              <ChevronLeft />
            </RoundIconButton>
          }
        >
          <ViewSwitch aria-label="View, phone header" floating views={["source", "rendered"]} value={view} onValueChange={setView} />
          <ActionMenu
            entries={tabActions(dirty, () => setDirty(false))}
            contentProps={{ align: "end", "aria-label": "File actions" }}
            trigger={
              <RoundIconButton label="File actions">
                <MoreHorizontal />
              </RoundIconButton>
            }
          />
          {dirty && (
            <RoundIconButton label="Save" dirty onClick={() => setDirty(false)}>
              <Save />
            </RoundIconButton>
          )}
        </PhoneHeader>
        <p className="absolute top-16 left-[22px] text-[30px] leading-[1.15] font-bold">Customer model</p>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <GuideValue>40 round, 14 from the edges, 8 apart; Save and its dot show until saved</GuideValue>
        {!dirty && (
          <Button variant="link" size="xs" className="px-0" onClick={() => setDirty(true)}>
            Make a change
          </Button>
        )}
      </div>
    </>
  )
}
