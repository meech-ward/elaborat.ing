import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { SidebarMenu, SidebarProvider } from "@/components/ui/sidebar"
import { Tabs, TabsList } from "@/components/ui/tabs"
import { ensureGeneratedNativeFont } from "@/features/drawings"
import { ActionMenu } from "../ui/ActionMenu"
import { Banner, BannerAction, Callout } from "../ui/Banner"
import { ButtonShortcut } from "../ui/ButtonShortcut"
import { EditorTab } from "../ui/EditorTab"
import { KindBadge } from "../ui/KindBadge"
import { SearchField } from "../ui/SearchField"
import { commandShortcut, isApplePlatform } from "../ui/shortcuts"
import { StatusDot } from "../ui/StatusDot"
import { TreeFileRow, TreeFolderRow } from "../ui/TreeRows"
import { ViewSwitch, type EditorView } from "../ui/ViewSwitch"
import { fileActions } from "./fileActions"
import { GuideCard, GuideLabel } from "./parts"

// The style guide's "Components and states" card, as it was approved, built
// from the library: three columns from lg up (buttons, then the view switch
// and tabs; tree rows and search, then the menu; banner, callout and status,
// then the canvas colours), one column on phones. Every state and component
// beyond these is further down the page.

// The focus ring, drawn on a button that does not have focus, to show it:
// the Button primitive's focus-visible outline without the condition.
const SHOWN_FOCUS = "outline-2 outline-offset-2 outline-solid outline-ring"

export function ComponentsSheet() {
  return (
    <GuideCard title="Components and states">
      {/* The tree rows are shadcn sidebar menu items, which need a provider. */}
      <SidebarProvider className="grid min-h-0 gap-7 lg:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-3">
          <ButtonsRow />
          <ViewSwitchAndTabs />
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          <TreeRowsAndSearch />
          <GuideLabel>Menu</GuideLabel>
          <MenuSpecimen />
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          <BannerCalloutStatus />
          <GuideLabel>Canvas</GuideLabel>
          <CanvasSample />
        </div>
      </SidebarProvider>
    </GuideCard>
  )
}

function ButtonsRow() {
  const save = commandShortcut("S", isApplePlatform())
  return (
    <>
      <GuideLabel>Buttons</GuideLabel>
      <div className="flex flex-wrap items-center gap-2.5">
        <Button aria-keyshortcuts={save.aria}>
          Save
          <ButtonShortcut>{save.label}</ButtonShortcut>
        </Button>
        <Button variant="secondary">New folder</Button>
        <Button variant="outline">Cancel</Button>
        <Button variant="destructive">Delete</Button>
        <Button className={SHOWN_FOCUS}>Focused</Button>
      </div>
    </>
  )
}

function ViewSwitchAndTabs() {
  const [view, setView] = useState<EditorView>("split")
  const [tab, setTab] = useState("notes.mdx")
  return (
    <>
      <GuideLabel>View switch and tabs</GuideLabel>
      <div className="flex flex-wrap items-center gap-3">
        <ViewSwitch value={view} onValueChange={setView} />
        <Tabs value={tab} onValueChange={(next) => setTab(String(next))} className="contents">
          <TabsList aria-label="Open files, sample" className="flex flex-wrap items-center gap-3">
            <EditorTab value="notes.mdx" name="notes.mdx" badge={<KindBadge kind="note" />} dirty />
            <EditorTab value="flow" name="flow" badge={<KindBadge kind="drawing" />} />
            <EditorTab value="signup" name="signup" badge={<KindBadge kind="diagram" />} />
          </TabsList>
        </Tabs>
      </div>
    </>
  )
}

function TreeRowsAndSearch() {
  return (
    <>
      <GuideLabel>Tree rows and search</GuideLabel>
      <SearchField placeholder="Search" aria-label="Search notes, drawings and diagrams" />
      <SidebarMenu aria-label="Tree rows, sample">
        <TreeFolderRow name="docs" open />
        <TreeFileRow name="customer-model.mdx" kind="note" depth={1} selected />
        <TreeFileRow name="pricing.md (hover)" kind="note" depth={1} className="bg-seg" />
      </SidebarMenu>
    </>
  )
}

/**
 * The menu held open as the style guide draws it, with Duplicate
 * highlighted: the real ActionMenu, laid out in place (its portal renders
 * here and the positioner is static), inert and hidden from assistive
 * technology, so it neither takes focus nor reacts to the pointer nor counts
 * as a menu on the page. "Try it", further down, has live ones.
 */
function MenuSpecimen() {
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  return (
    <div inert aria-hidden="true" ref={setContainer} data-specimen="menu">
      {container && (
        <ActionMenu
          open
          modal={false}
          entries={fileActions(() => {})}
          trigger={<button type="button" tabIndex={-1} aria-label="Example menu" className="sr-only" />}
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

function BannerCalloutStatus() {
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
      </div>
    </>
  )
}

/** Shapes in the fills with ink, connectors in accentInk, a note in inkSoft, in the drawing font. */
function CanvasSample() {
  // The drawing font loads on demand.
  useEffect(() => {
    ensureGeneratedNativeFont().catch(() => {
      /* The sample falls back to a cursive font. */
    })
  }, [])
  return (
    <svg width="420" height="120" viewBox="0 0 420 120" aria-label="Canvas colours" className="h-auto max-w-full font-[family-name:Excalifont,cursive]">
      <rect x="6" y="20" width="118" height="64" rx="14" className="fill-pastel-blue stroke-ink" strokeWidth="2" />
      <text x="65" y="58" textAnchor="middle" fontSize="20" className="fill-ink">
        note
      </text>
      <ellipse cx="206" cy="52" rx="62" ry="34" className="fill-pastel-yellow stroke-ink" strokeWidth="2" />
      <text x="206" y="58" textAnchor="middle" fontSize="20" className="fill-ink">
        idea
      </text>
      <rect x="294" y="20" width="118" height="64" rx="12" className="fill-d2-fill stroke-ink" strokeWidth="2" />
      <text x="353" y="58" textAnchor="middle" fontSize="20" className="fill-ink">
        d2
      </text>
      <path d="M124 52H140M268 52H290" fill="none" className="stroke-accent-ink" strokeWidth="2" strokeLinecap="round" />
      <text x="6" y="110" fontSize="16" className="fill-ink-soft">
        ink, inkSoft, accentInk, fills
      </text>
    </svg>
  )
}
