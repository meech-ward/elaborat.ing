import { Bot, FolderPlus, Info, Maximize2, Plus, Sun } from "lucide-react"
import { DottedPage } from "@/components/panel"
import { Button } from "@/components/ui/button"
import { SidebarMenu, SidebarProvider } from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"
import { DiagramInNote } from "../guide/c5Samples"
import { IconRow, PersonRow } from "./AccountRows"
import { Callout } from "./Banner"
import { EditorHeader } from "./EditorHeader"
import { FloatingPanel } from "./FloatingPanel"
import { IconButton } from "./IconButton"
import { KindBadge, type FileKind } from "./KindBadge"
import { NoteProse } from "./NoteProse"
import { ProjectHeader } from "./ProjectHeader"
import { SaveButton } from "./SaveButton"
import { ScaleToFit } from "./ScaleToFit"
import { SearchField } from "./SearchField"
import { SourceLines, type SourcePart } from "./SourceLines"
import { SplitPanes } from "./SplitPanes"
import { TabLine } from "./TabLine"
import { TreeFileRow, TreeFolderRow } from "./TreeRows"
import { ViewSwitch } from "./ViewSwitch"

// A picture of the app, made of the app's own components, so it takes the
// active palette and light or dark as the app does. No primitive fits a
// picture; it is inert and hidden from screen readers.

const WIDTH = 1440
const HEIGHT = 900
const noop = () => {}

const TABS: readonly [string, FileKind][] = [
  ["customer-model.mdx", "note"],
  ["flow.excalidraw", "drawing"],
  ["signup.d2", "diagram"],
  ["pricing.md", "note"],
  ["onboarding.mdx", "note"],
  ["roadmap.md", "note"],
  ["billing.d2", "diagram"],
  ["README.md", "note"],
  ["agents.mdx", "note"],
  ["sketch.excalidraw", "drawing"],
]

// customer-model.mdx as C5 screen 1 shows it, coloured as the editor colours it.
const SOURCE: readonly (readonly SourcePart[])[] = [
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

function Sidebar() {
  return (
    <SidebarProvider className="flex min-h-0 w-[264px] shrink-0 flex-col">
      <ProjectHeader name="Product notes" menu={[]} onShare={noop} className="mb-4" />
      <FloatingPanel className="mb-[9px] flex min-h-0 flex-1 flex-col px-2 py-2.5">
        <SearchField placeholder="Search" className="mx-0.5 mb-1.5 w-auto" />
        <div className="mx-0.5 mb-2 grid grid-cols-2 gap-1.5">
          <Button size="sm" className="rounded-tool">
            <Plus strokeWidth={2.4} />
            New file
          </Button>
          <Button size="sm" variant="secondary" className="rounded-tool">
            <FolderPlus />
            New folder
          </Button>
        </div>
        <SidebarMenu>
          <TreeFolderRow name="art" open />
          <TreeFileRow name="flow.excalidraw" kind="drawing" depth={1} />
          <TreeFolderRow name="docs" open />
          <TreeFileRow name="customer-model.mdx" kind="note" depth={1} selected dirty />
          <TreeFileRow name="onboarding.mdx" kind="note" depth={1} />
          <TreeFileRow name="pricing.md" kind="note" depth={1} />
          <TreeFileRow name="roadmap.md" kind="note" depth={1} />
          <TreeFolderRow name="flows" open />
          <TreeFileRow name="billing.d2" kind="diagram" depth={1} />
          <TreeFileRow name="signup.d2" kind="diagram" depth={1} />
          <TreeFileRow name="README.md" kind="note" />
        </SidebarMenu>
      </FloatingPanel>
      <FloatingPanel className="flex flex-col p-2">
        <SidebarMenu>
          <IconRow icon={<Bot />} label="Connected agents" count={2} />
          <IconRow icon={<Sun />} label="Look and theme" />
        </SidebarMenu>
        <PersonRow name="Person" email="person@example.com" menu={[]} />
      </FloatingPanel>
    </SidebarProvider>
  )
}

function Editor() {
  return (
    <FloatingPanel className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <EditorHeader>
        <TabLine
          items={TABS.map(([name, kind]) => ({ value: name, name, badge: <KindBadge kind={kind} />, dirty: name === TABS[0][0] }))}
          value={TABS[0][0]}
          onValueChange={noop}
        />
        <ViewSwitch value="split" onValueChange={noop} />
        <SaveButton />
        <IconButton label="Focus">
          <Maximize2 />
        </IconButton>
      </EditorHeader>
      <SplitPanes
        className="min-h-0 flex-1"
        startSize="46.45%"
        start={<SourceLines lines={SOURCE} currentLine={22} className="h-full overflow-hidden" />}
        end={
          <NoteProse className="h-full overflow-hidden">
            <h1>Customer model</h1>
            <p>How a customer moves from sign-up to their first project, and where agents help.</p>
            <Callout icon={<Info />}>Agents act as the signed-in person in every project they can open.</Callout>
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
        }
      />
    </FloatingPanel>
  )
}

/**
 * C5's note in Split (screen 1) as a picture: the sidebar and the editor on
 * the dotted page, 1440 by 900, scaled to the frame's width. The frame is
 * a panel (border, radius 14, the panel shadow) that keeps the screen's
 * proportions. Inert and hidden from screen readers: it shows the app, it
 * is not the app.
 */
export function ScreenPreview({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      inert
      data-slot="screen-preview"
      className={cn("w-full overflow-hidden rounded-panel border border-border bg-(--bg) shadow-panel select-none", className)}
    >
      <ScaleToFit width={WIDTH}>
        <DottedPage className="flex min-h-0 gap-4 p-4" style={{ height: HEIGHT }}>
          <Sidebar />
          <Editor />
        </DottedPage>
      </ScaleToFit>
    </div>
  )
}
