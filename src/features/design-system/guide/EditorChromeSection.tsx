import { useState } from "react"
import { ChevronLeft, Maximize2, Minimize2, Save } from "lucide-react"
import { DottedPage } from "@/components/panel"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList } from "@/components/ui/tabs"
import { EditorTab } from "../ui/EditorTab"
import { FloatingPanel } from "../ui/FloatingPanel"
import { IconButton, RoundIconButton } from "../ui/IconButton"
import { KindBadge, type FileKind } from "../ui/KindBadge"
import { SaveButton } from "../ui/SaveButton"
import { commandShortcut, isApplePlatform } from "../ui/shortcuts"
import { TabLine, type TabLineItem } from "../ui/TabLine"
import { ViewSwitch, type EditorView } from "../ui/ViewSwitch"
import { GuideGroup, GuideLabel, GuideValue } from "./parts"

// The Editor chrome group: the open-file tabs, the view switch, Save and the
// icon buttons, each in its states, then assembled as the C5 screens use
// them: the desktop top line, the focus mode header and the phone header.

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

export function EditorChromeSection() {
  return (
    <GuideGroup title="Editor chrome">
      <div className="flex flex-col gap-7">
        <div className="grid gap-7 lg:grid-cols-3">
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
        <div className="grid gap-7 lg:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-3">
            <FocusHeader />
          </div>
          <div className="flex min-w-0 flex-col gap-3">
            <PhoneHeader />
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

/** C5 screen 1's top line: the open files, the view switch, Save and Focus. */
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
  const save = () => {
    if (!active) return
    const next = new Set(dirty)
    next.delete(active)
    setDirty(next)
  }

  return (
    <>
      <GuideLabel>C5 desktop top line</GuideLabel>
      <FloatingPanel className="max-w-[1128px] overflow-hidden">
        <div className="flex h-[46px] items-center gap-1.5 px-1.5 pointer-coarse:h-[52px]">
          <TabLine items={open.map((path) => tabItem(path, dirty))} value={active} onValueChange={setActive} onClose={close} />
          <ViewSwitch value={view} onValueChange={setView} />
          <SaveButton disabled={!active || !dirty.has(active)} onClick={save} />
          <IconButton label="Focus" shortcut={focus.label} keyShortcuts={focus.aria}>
            <Maximize2 />
          </IconButton>
        </div>
        <div className="h-6 border-t border-border" />
      </FloatingPanel>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <GuideValue>Live: pick, close (point at a tab, or Delete) and save tabs; 1128 wide, as on the 1440 screen</GuideValue>
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

/** C5 screens 4 and 5: full screen, the header floats at the top right. */
function FocusHeader() {
  const [view, setView] = useState<EditorView>("rendered")
  const focus = commandShortcut(".", isApplePlatform())
  return (
    <>
      <GuideLabel>Focus mode header</GuideLabel>
      <DottedPage className="relative h-[92px] min-h-0 overflow-hidden rounded-panel border border-border">
        <FloatingPanel className="absolute top-4 right-4 flex h-11 items-center gap-1.5 rounded-menu px-1.5 pointer-coarse:h-[52px]">
          <ViewSwitch value={view} onValueChange={setView} />
          <SaveButton />
          <IconButton label="Exit full screen" shortcut={focus.label} keyShortcuts={focus.aria}>
            <Minimize2 />
          </IconButton>
        </FloatingPanel>
      </DottedPage>
      <GuideValue>44 high, radius 12, padding 6, gap 6, the panel shadow; 16 from the top and right</GuideValue>
    </>
  )
}

/** The phone note: Back at the top left, Save with its unsaved dot at the top right. */
function PhoneHeader() {
  const [dirty, setDirty] = useState(true)
  return (
    <>
      <GuideLabel>Phone header</GuideLabel>
      <div className="relative h-[124px] w-full max-w-[390px] overflow-hidden rounded-panel border border-border bg-panel">
        <RoundIconButton label="Back to files and projects" className="absolute top-3.5 left-3.5">
          <ChevronLeft />
        </RoundIconButton>
        <RoundIconButton label="Save" dirty={dirty} className="absolute top-3.5 right-3.5" onClick={() => setDirty(false)}>
          <Save />
        </RoundIconButton>
        <p className="absolute top-16 left-[22px] text-[30px] leading-[1.15] font-bold">Onboarding</p>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <GuideValue>40 round, 14 from the edges; Save shows the dot until saved</GuideValue>
        {!dirty && (
          <Button variant="link" size="xs" className="px-0" onClick={() => setDirty(true)}>
            Make a change
          </Button>
        )}
      </div>
    </>
  )
}
