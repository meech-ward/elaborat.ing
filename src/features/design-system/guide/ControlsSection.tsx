import { useState } from "react"
import { ChevronDown, Diamond, Maximize2, Plus, Settings, UserPlus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
import { CustomCodeNotice, CustomCodeProvider, type CodeFile, type CustomCodePolicy } from "@/features/custom-code"
import { ActionContextMenu, ActionMenu } from "../ui/ActionMenu"
import { Banner } from "../ui/Banner"
import { ButtonShortcut } from "../ui/ButtonShortcut"
import { EmptyState } from "../ui/EmptyState"
import { Hint } from "../ui/Hint"
import { LoadingLine } from "../ui/LoadingLine"
import { commandShortcut, isApplePlatform } from "../ui/shortcuts"
import { DirtyDot, StatusDot } from "../ui/StatusDot"
import { fileActions } from "./fileActions"
import { GuideGroup, GuideLabel, GuideValue, useGuidePortal } from "./parts"

// The Controls group: the button sizes and disabled states, keys, tooltips,
// live menus, the empty state and the custom code notice built on it, the
// other banner tones and status, the unsaved dot and loading lines. The approved sheet at the top of the page
// has the buttons, the menu and the warn banner, callout and status; this
// group has the rest. Three columns from lg up; one column on phones.

export function ControlsSection() {
  return (
    <GuideGroup title="Controls">
      <div className="grid gap-7 lg:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-3">
          <ButtonsDemo />
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          <MenuDemo />
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          <FeedbackDemo />
        </div>
      </div>
    </GuideGroup>
  )
}

function ButtonsDemo() {
  const apple = isApplePlatform()
  const save = commandShortcut("S", apple)
  const focus = commandShortcut(".", apple)
  const palette = commandShortcut("P", apple)
  return (
    <>
      <GuideLabel>Sizes</GuideLabel>
      <div className="flex flex-wrap items-center gap-2.5">
        <Button size="sm" aria-keyshortcuts={save.aria}>
          Save
          <ButtonShortcut>{save.label}</ButtonShortcut>
        </Button>
        <Button size="lg">Create project</Button>
        <Button size="touch">New file</Button>
        <Button variant="secondary" size="icon" aria-label="New file">
          <Plus />
        </Button>
        <Button variant="secondary" size="icon-lg" aria-label="New file">
          <Plus />
        </Button>
      </div>
      <GuideValue>
        30 toolbar, 32, 36 large, 40 touch (15px, radius 10); icons 30 and 40; radius 9; 600 13px. On touch screens every size is at
        least 40 high.
      </GuideValue>
      <GuideLabel>Disabled</GuideLabel>
      <div className="flex flex-wrap items-center gap-2.5">
        <Button disabled>Save</Button>
        <Button variant="secondary" disabled>
          New folder
        </Button>
        <Button variant="outline" disabled>
          Cancel
        </Button>
        <Button variant="destructive" disabled>
          Delete
        </Button>
      </div>
      <GuideValue>Point at a button or press it to see hover and press.</GuideValue>

      <GuideLabel>Kbd</GuideLabel>
      <div className="flex flex-wrap items-center gap-2.5">
        <Kbd>{palette.label}</Kbd>
        <KbdGroup>
          {(apple ? ["⌘", "⇧", "P"] : ["Ctrl", "Shift", "P"]).map((key) => (
            <Kbd key={key}>{key}</Kbd>
          ))}
        </KbdGroup>
        <Kbd>F2</Kbd>
        <Kbd>Esc</Kbd>
      </div>

      <GuideLabel>Tooltip</GuideLabel>
      <div className="flex flex-wrap items-center gap-1">
        <Hint label="Focus" shortcut={focus.label}>
          <Button variant="ghost" size="icon" aria-label={`Focus (${focus.label})`} aria-keyshortcuts={focus.aria}>
            <Maximize2 />
          </Button>
        </Hint>
        <Hint label="Share project">
          <Button variant="ghost" size="icon" aria-label="Share project">
            <UserPlus />
          </Button>
        </Hint>
        <Hint label="Settings, help and terms">
          <Button variant="ghost" size="icon" aria-label="Settings, help and terms">
            <Settings />
          </Button>
        </Hint>
        <GuideValue className="ml-2">Point at or tab to an icon button.</GuideValue>
      </div>
    </>
  )
}

function MenuDemo() {
  const [chosen, setChosen] = useState<string | null>(null)
  const entries = fileActions(setChosen)
  // The menus open inside the page's main landmark, not at the end of the body.
  const portal = useGuidePortal()
  return (
    <>
      <GuideLabel>Try it</GuideLabel>
      <div className="flex flex-wrap items-stretch gap-2.5">
        <ActionMenu
          entries={entries}
          contentProps={{ container: portal }}
          trigger={
            <Button variant="outline">
              File actions
              <ChevronDown data-icon="inline-end" />
            </Button>
          }
        />
        <ActionContextMenu
          entries={entries}
          aria-label="File actions"
          contentProps={{ container: portal }}
          className="flex min-h-10 min-w-0 flex-1 items-center justify-center rounded-button border border-dashed border-panel-border px-3 text-center text-[13px] text-muted-foreground"
        >
          Right-click here, or press and hold
        </ActionContextMenu>
      </div>
      <p aria-live="polite" className="leading-none">
        <GuideValue>{chosen ? `Chose ${chosen}` : "Choose an item to see it here"}</GuideValue>
      </p>

      <GuideLabel>Empty state</GuideLabel>
      <div className="rounded-panel border border-dashed border-panel-border">
        <EmptyState
          icon={<Diamond />}
          title="A place for connected ideas."
          description="Open a file or create a note to begin."
          actions={
            <>
              <Button variant="secondary">Open explorer</Button>
              <Button>New note</Button>
            </>
          }
        />
      </div>

      <GuideLabel>Custom code notice</GuideLabel>
      <div className="rounded-panel border border-dashed border-panel-border">
        <CustomCodeProvider value={SAMPLE_CODE_POLICY}>
          <CustomCodeNotice files={SAMPLE_CODE_FILES} onRun={noop} onShowSource={noop} />
        </CustomCodeProvider>
      </div>
    </>
  )
}

const noop = () => {}

/** A note in a shared project that imports a component file Ana changed and exports code of its own. */
const SAMPLE_CODE_FILES: CodeFile[] = [
  { path: "ui/release-card.mdx", token: "sample-card", own: false },
  { path: "notes/launch-plan.mdx", token: "sample-note", own: true },
]
const SAMPLE_CODE_POLICY: CustomCodePolicy = {
  key: "style-guide",
  editors: async () =>
    new Map([
      ["ui/release-card.mdx", "Ana"],
      ["notes/launch-plan.mdx", "you"],
    ]),
}

function FeedbackDemo() {
  return (
    <>
      <GuideLabel>Banner tones</GuideLabel>
      <Banner tone="danger">Render error on line 4. The source is unchanged and stays editable.</Banner>
      <Banner tone="info">Offline: showing the projects on this device. Changes sync when you are back online.</Banner>

      <GuideLabel>Offline status</GuideLabel>
      <div className="flex flex-wrap gap-x-4 gap-y-2 text-[13px] text-muted-foreground">
        <StatusDot status="offline" />
      </div>

      <GuideLabel>Dirty dot</GuideLabel>
      <span className="inline-flex items-center gap-[7px] text-[13px] font-semibold">
        notes.mdx
        <DirtyDot label="Unsaved changes" />
      </span>

      <GuideLabel>Loading line</GuideLabel>
      <div className="overflow-hidden rounded-panel border border-panel-border bg-panel">
        <LoadingLine label="Opening customer-model.mdx" />
        <p className="px-3 py-2.5 text-[13px] text-muted-foreground">Opening customer-model.mdx</p>
      </div>
      <div className="overflow-hidden rounded-panel border border-panel-border bg-panel">
        <LoadingLine value={60} label="Uploading flow.excalidraw" />
        <p className="px-3 py-2.5 text-[13px] text-muted-foreground">Uploading flow.excalidraw, 60%</p>
      </div>
    </>
  )
}
