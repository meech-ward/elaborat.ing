import { useState } from "react"
import { ChevronDown, Diamond, Maximize2, Plus, Settings, UserPlus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
import { ActionContextMenu, ActionMenu, type MenuEntry } from "../ui/ActionMenu"
import { Banner, BannerAction, Callout } from "../ui/Banner"
import { ButtonShortcut } from "../ui/ButtonShortcut"
import { EmptyState } from "../ui/EmptyState"
import { Hint } from "../ui/Hint"
import { LoadingLine } from "../ui/LoadingLine"
import { DirtyDot, StatusDot } from "../ui/StatusDot"
import { GuideGroup, GuideLabel, GuideValue } from "./parts"

// The Controls group: buttons, keys, tooltips, menus, banners, callouts,
// status, loading and empty states, each in its states. Laid out in the
// style guide's three columns from lg up; one column on phones.

// The focus ring, drawn on a button that does not have focus, to show it:
// the Button primitive's focus-visible outline without the condition.
const SHOWN_FOCUS = "outline-2 outline-offset-2 outline-solid outline-ring"

function fileActions(choose: (label: string) => void): MenuEntry[] {
  return [
    { label: "Rename", shortcut: "F2", keyShortcuts: "F2", onSelect: () => choose("Rename") },
    { label: "Duplicate", shortcut: "⌘D", keyShortcuts: "Meta+D", onSelect: () => choose("Duplicate") },
    { label: "Move to…", onSelect: () => choose("Move to…") },
    { label: "Delete", shortcut: "⌫", keyShortcuts: "Backspace", destructive: true, onSelect: () => choose("Delete") },
  ]
}

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
  return (
    <>
      <GuideLabel>Buttons</GuideLabel>
      <div className="flex flex-wrap items-center gap-2.5">
        <Button aria-keyshortcuts="Meta+S">
          Save
          <ButtonShortcut>⌘S</ButtonShortcut>
        </Button>
        <Button variant="secondary">New folder</Button>
        <Button variant="outline">Cancel</Button>
        <Button variant="destructive">Delete</Button>
        <Button className={SHOWN_FOCUS}>Focused</Button>
      </div>
      <GuideLabel>Sizes</GuideLabel>
      <div className="flex flex-wrap items-center gap-2.5">
        <Button size="sm" aria-keyshortcuts="Meta+S">
          Save
          <ButtonShortcut>⌘S</ButtonShortcut>
        </Button>
        <Button size="lg">Create project</Button>
        <Button variant="secondary" size="icon" aria-label="New file">
          <Plus />
        </Button>
        <Button variant="secondary" size="icon-lg" aria-label="New file">
          <Plus />
        </Button>
      </div>
      <GuideValue>30 toolbar, 32, 36 large; icons 30 and 40; radius 9; 600 13px</GuideValue>
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
        <Kbd>⌘P</Kbd>
        <KbdGroup>
          <Kbd>⌘</Kbd>
          <Kbd>⇧</Kbd>
          <Kbd>P</Kbd>
        </KbdGroup>
        <Kbd>F2</Kbd>
        <Kbd>Esc</Kbd>
      </div>

      <GuideLabel>Tooltip</GuideLabel>
      <div className="flex flex-wrap items-center gap-1">
        <Hint label="Focus" shortcut="⌘.">
          <Button variant="ghost" size="icon" aria-label="Focus (⌘.)" aria-keyshortcuts="Meta+.">
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
  return (
    <>
      <GuideLabel>Menu</GuideLabel>
      <MenuSpecimen />
      <GuideLabel>Try it</GuideLabel>
      <div className="flex flex-wrap items-stretch gap-2.5">
        <ActionMenu
          entries={entries}
          trigger={
            <Button variant="outline" className="pointer-coarse:h-10">
              File actions
              <ChevronDown data-icon="inline-end" />
            </Button>
          }
        />
        <ActionContextMenu
          entries={entries}
          aria-label="File actions"
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
    </>
  )
}

/**
 * The menu held open as the style guide draws it, with Duplicate
 * highlighted: the real ActionMenu, laid out in place (its portal renders
 * here and the positioner is static) and inert, so it neither takes focus
 * nor reacts to the pointer. "Try it" below has the live ones.
 */
function MenuSpecimen() {
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  return (
    <div inert ref={setContainer} data-specimen="menu">
      {container && (
        <ActionMenu
          open
          modal={false}
          entries={fileActions(() => {})}
          trigger={<button type="button" aria-label="Example menu" className="sr-only" />}
          contentProps={{
            container,
            sideOffset: 0,
            positionerClassName: "static! transform-none!",
            // The highlighted look, drawn on the second item: the menu
            // primitive's data-highlighted colours.
            className: "max-h-none! w-fit [&>*:nth-child(2)]:bg-accent [&>*:nth-child(2)]:text-accent-foreground",
          }}
        />
      )}
    </div>
  )
}

function FeedbackDemo() {
  return (
    <>
      <GuideLabel>Banner, callout, status</GuideLabel>
      <Banner tone="warn" action={<BannerAction>Compare</BannerAction>}>
        pricing.md changed on another device.
      </Banner>
      <Callout>Agents act as the signed-in person in every project they can open.</Callout>
      <div className="flex flex-wrap gap-x-4 gap-y-2 text-[13px] text-muted-foreground">
        <StatusDot status="synced" />
        <StatusDot status="unsaved" />
        <StatusDot status="failed" />
        <StatusDot status="offline" />
      </div>

      <GuideLabel>Banner tones</GuideLabel>
      <Banner tone="danger">Render error on line 4. The source is unchanged and stays editable.</Banner>
      <Banner tone="info">Offline: showing the projects on this device. Changes sync when you are back online.</Banner>

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
