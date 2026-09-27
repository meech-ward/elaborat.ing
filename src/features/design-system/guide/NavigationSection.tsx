import { Bot, FolderPlus, Plus, Sun } from "lucide-react"
import { DottedPage } from "@/components/panel"
import { Button } from "@/components/ui/button"
import { SidebarMenu, SidebarMenuItem, SidebarProvider } from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"
import { IconRow, PersonRow } from "../ui/AccountRows"
import type { MenuEntry } from "../ui/ActionMenu"
import { FloatingPanel } from "../ui/FloatingPanel"
import { KindBadge } from "../ui/KindBadge"
import { PanelMessage } from "../ui/PanelMessage"
import { PanelRow } from "../ui/PanelRow"
import { ProjectHeader } from "../ui/ProjectHeader"
import { SearchField } from "../ui/SearchField"
import { SearchHitRow } from "../ui/SearchHitRow"
import { StatusDot } from "../ui/StatusDot"
import { TreeFileRow, TreeFolderRow, TreeNameField, TreeRowMenu } from "../ui/TreeRows"
import { phoneBleed } from "./c5Samples"
import { GuideGroup, GuideLabel, GuideValue } from "./parts"

// The Navigation group: the sidebar's floating panels, rows, search, the
// project header and the account rows, each in its states, then put
// together as the C5 desktop sidebar and the phone's files screen.
// The rows are built on shadcn's sidebar menu, which needs a
// SidebarProvider above it; the workbench has one, and this section brings
// its own.

// Hover and focus drawn on purpose, so the page shows those states at rest.
const hover = "bg-seg"
const focus = "outline-2 -outline-offset-2 outline-ring outline-solid"

const noop = () => {}

// The project menu: the projects (the open one current), the way home, then the project's actions.
const projectMenu: MenuEntry[] = [
  { label: "Product notes", group: "projects", current: true, onSelect: noop },
  { label: "Research", group: "projects", onSelect: noop },
  { label: "All projects", group: "home", onSelect: noop },
  { label: "Import a file", group: "actions", onSelect: noop },
  { label: "Refresh file list", group: "actions", onSelect: noop },
  { label: "Command palette", group: "actions", onSelect: noop },
]

const personMenu: MenuEntry[] = [
  { label: "Settings", onSelect: noop },
  { label: "Sync now", onSelect: noop },
  { label: "Sign out", onSelect: noop },
]

const fileMenu: MenuEntry[] = [
  { label: "Rename", onSelect: noop, shortcut: "F2", keyShortcuts: "F2" },
  { label: "Duplicate", onSelect: noop },
  { label: "Move to…", onSelect: noop },
  { label: "Delete", onSelect: noop, destructive: true },
]

function States() {
  return (
    <div className="grid grid-cols-1 gap-7 lg:grid-cols-3">
      <div className="flex min-w-0 flex-col gap-3">
        <GuideLabel>Tree rows and search</GuideLabel>
        <SearchField placeholder="Search" aria-label="Search notes, drawings and diagrams" />
        <SidebarMenu aria-label="Tree row states">
          <TreeFolderRow name="docs" open />
          <TreeFileRow name="customer-model.mdx" kind="note" depth={1} selected dirty />
          <TreeFileRow name="pricing.md (hover)" kind="note" depth={1} className={hover} />
          <TreeFileRow name="roadmap.md (focus)" kind="note" depth={1} className={focus} />
          <TreeFileRow name="onboarding.mdx" kind="note" depth={1} dirty actions={<TreeRowMenu label="Actions for docs/onboarding.mdx" entries={fileMenu} />} />
          <TreeFolderRow name="flows" open={false} />
          <TreeFileRow name="README.md" kind="note" />
        </SidebarMenu>
        <GuideValue>
          Folder open, file selected with unsaved changes, hover, focus, actions on hover (ellipsis), folder closed, a file at the top.
        </GuideValue>
        <GuideLabel>New entry name</GuideLabel>
        <SidebarMenu aria-label="New entry name states">
          <TreeFolderRow name="docs" open />
          <TreeNameField depth={1} defaultValue="untitled.mdx" aria-label="Name of the new note in docs" />
          <TreeNameField depth={1} defaultValue="pricing.md" error="pricing.md already exists here. Choose another name." aria-label="Name of the new note in docs, taken" />
        </SidebarMenu>
        <GuideValue>Where the new file will appear, at its depth; a name that cannot be used says why under it.</GuideValue>
        <GuideLabel>Search results</GuideLabel>
        <SearchField value="customer" readOnly onClear={() => {}} aria-label="Search sample with text" />
        <SidebarMenu aria-label="Search result sample">
          <SearchHitRow path="docs/customer-model.mdx" kind="note" before="How a " match="customer" after=" moves from sign-up to their first project, and where agents help." />
          <SearchHitRow path="flows/billing.d2" kind="diagram" before="" match="customer" after=" -> invoice" />
        </SidebarMenu>
        <GuideValue>A hit replaces the tree while the field has text: the path, and the words around the match. Clear search (the x) or Escape empties the field.</GuideValue>
        <GuideLabel>Kind badges</GuideLabel>
        <div className="flex items-center gap-4">
          {(
            [
              ["note", "note"],
              ["drawing", "drawing"],
              ["diagram", "diagram"],
            ] as const
          ).map(([kind, label]) => (
            <span key={kind} className="flex items-center gap-1.5 text-[13px]">
              <KindBadge kind={kind} />
              <GuideValue>{label}</GuideValue>
            </span>
          ))}
        </div>
      </div>

      <div className="flex min-w-0 flex-col gap-3">
        <GuideLabel>Project header</GuideLabel>
        <ProjectHeader name="Product notes" menu={projectMenu} onShare={noop} />
        <GuideLabel>Account rows</GuideLabel>
        <FloatingPanel className="flex flex-col p-2">
          <SidebarMenu>
            <IconRow icon={<Bot />} label="Connected agents" count={2} />
            <IconRow icon={<Sun />} label="Look and theme" className={hover} />
          </SidebarMenu>
          <PersonRow name="Person" email="person@example.com" menu={personMenu} />
        </FloatingPanel>
        <GuideValue>Connected agents with its count; Look and theme on hover; the person with the gear menu.</GuideValue>
      </div>

      <div className="flex min-w-0 flex-col gap-3">
        <GuideLabel>Panel rows</GuideLabel>
        <SidebarMenu aria-label="Panel row states">
          <SidebarMenuItem>
            <PanelRow>Default</PanelRow>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <PanelRow className={hover}>Hover</PanelRow>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <PanelRow isActive>Selected</PanelRow>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <PanelRow className={focus}>Focus</PanelRow>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <PanelRow size="touch">Phone, 40 high</PanelRow>
          </SidebarMenuItem>
        </SidebarMenu>
        <GuideValue>28 high, radius 7, 13px; hover seg; selected accentSoft 600.</GuideValue>
        <GuideLabel>Panel messages</GuideLabel>
        <PanelMessage className="px-2">Loading files…</PanelMessage>
        <PanelMessage size="touch" className="px-2">No files yet. Create a note to start.</PanelMessage>
        <GuideValue>Words in place of rows: muted, 13px, and 15px on a phone.</GuideValue>
        <GuideLabel>Floating panels</GuideLabel>
        <div className="grid grid-cols-2 gap-4">
          <FloatingPanel className="flex h-16 items-center justify-center">
            <GuideValue>floating</GuideValue>
          </FloatingPanel>
          <FloatingPanel variant="flat" className="flex h-16 items-center justify-center">
            <GuideValue>flat (phones)</GuideValue>
          </FloatingPanel>
        </div>
      </div>
    </div>
  )
}

/** C5 screen 1's left column: 264 wide, 16 from the edges of a 900 high screen. */
function DesktopSidebar() {
  return (
    <DottedPage className="flex h-[900px] min-h-0 w-[296px] shrink-0 flex-col rounded-[4px] p-4">
      <ProjectHeader name="Product notes" menu={projectMenu} onShare={noop} className="mb-4" />
      <FloatingPanel render={<nav aria-label="Files, desktop sample" />} className="mb-[9px] flex min-h-0 flex-1 flex-col px-2 py-2.5">
        <SearchField placeholder="Search" aria-label="Search notes, drawings and diagrams" className="mx-0.5 mb-1.5 w-auto" />
        <div className="mx-0.5 mb-2 grid grid-cols-2 gap-1.5">
          <Button size="sm" className="rounded-tool">
            <Plus aria-hidden="true" strokeWidth={2.4} />
            New file
          </Button>
          <Button size="sm" variant="secondary" className="rounded-tool">
            <FolderPlus aria-hidden="true" />
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
        <PersonRow name="Person" email="person@example.com" menu={personMenu} status={<StatusDot status="synced" />} />
      </FloatingPanel>
    </DottedPage>
  )
}

/**
 * The phone's files and projects screen (390 by 844): 40px rows and 15px
 * text, each with its actions button (phones have no hover). The sync status
 * takes the gear's place, so the person's row itself opens the settings menu.
 */
function PhoneFiles() {
  return (
    <DottedPage className={cn("flex h-[844px] min-h-0 w-full flex-col gap-2.5 rounded-[4px] p-3", phoneBleed)}>
      <ProjectHeader name="Product notes" menu={projectMenu} onShare={noop} size="touch" variant="flat" />
      <FloatingPanel
        variant="flat"
        render={<nav aria-label="Files and projects, phone sample" />}
        className="flex min-h-0 flex-1 flex-col overflow-hidden p-2.5"
      >
        <SearchField size="touch" placeholder="Search" aria-label="Search notes, drawings and diagrams" className="mb-2" />
        <div className="mb-2 grid grid-cols-2 gap-2">
          <Button size="touch">New file</Button>
          <Button variant="secondary" size="touch">
            New folder
          </Button>
        </div>
        <SidebarMenu>
          <TreeFolderRow size="touch" name="art" open actions={<TreeRowMenu size="touch" label="Actions for folder art, phone sample" entries={fileMenu} />} />
          <TreeFileRow size="touch" name="flow.excalidraw" kind="drawing" depth={1} actions={<TreeRowMenu size="touch" label="Actions for art/flow.excalidraw, phone sample" entries={fileMenu} />} />
          <TreeFolderRow size="touch" name="docs" open actions={<TreeRowMenu size="touch" label="Actions for folder docs, phone sample" entries={fileMenu} />} />
          <TreeFileRow size="touch" name="customer-model.mdx" kind="note" depth={1} selected dirty actions={<TreeRowMenu size="touch" label="Actions for docs/customer-model.mdx, phone sample" entries={fileMenu} />} />
          <TreeFileRow size="touch" name="onboarding.mdx" kind="note" depth={1} actions={<TreeRowMenu size="touch" label="Actions for docs/onboarding.mdx, phone sample" entries={fileMenu} />} />
          <TreeFileRow size="touch" name="pricing.md" kind="note" depth={1} actions={<TreeRowMenu size="touch" label="Actions for docs/pricing.md, phone sample" entries={fileMenu} />} />
          <TreeFolderRow size="touch" name="flows" open={false} actions={<TreeRowMenu size="touch" label="Actions for folder flows, phone sample" entries={fileMenu} />} />
          <TreeFileRow size="touch" name="README.md" kind="note" actions={<TreeRowMenu size="touch" label="Actions for README.md, phone sample" entries={fileMenu} />} />
        </SidebarMenu>
      </FloatingPanel>
      <FloatingPanel variant="flat" className="flex flex-col px-2 pt-1.5 pb-1">
        <SidebarMenu>
          <IconRow size="touch" icon={<Sun />} label="Look and theme" />
        </SidebarMenu>
        <PersonRow
          size="touch"
          name="Person"
          email="person@example.com"
          menu={personMenu}
          trailing={<StatusDot status="synced" size="touch" />}
        />
      </FloatingPanel>
    </DottedPage>
  )
}

export function NavigationSection() {
  return (
    <GuideGroup title="Navigation">
      <SidebarProvider className="flex min-h-0 flex-col gap-7">
        <States />
        <div className="flex flex-wrap items-start gap-7">
          <div className="flex flex-col gap-3">
            <GuideLabel>C5 sidebar, desktop</GuideLabel>
            <DesktopSidebar />
          </div>
          <div className="flex w-full max-w-[390px] flex-col gap-3">
            <GuideLabel>Files screen, phone at 390</GuideLabel>
            <PhoneFiles />
          </div>
        </div>
      </SidebarProvider>
    </GuideGroup>
  )
}
