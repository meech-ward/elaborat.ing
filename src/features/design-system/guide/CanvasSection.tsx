import { useEffect, useRef, useState, type ReactNode } from "react"
import { DottedPage } from "@/components/panel"
import { Button } from "@/components/ui/button"
import { ensureGeneratedNativeFont } from "@/features/drawings"
import { cn } from "@/lib/utils"
import {
  CanvasIsland,
  MoreTools,
  ToolButton,
  ToolGroup,
  ZoomControl,
  canvasTools,
  islandTools,
  toolEntries,
  type IslandSize,
} from "../ui/CanvasIsland"
import { QuickOpen, type QuickOpenCommand, type QuickOpenFile, type QuickOpenMode } from "../ui/QuickOpen"
import { commandShortcut, isApplePlatform } from "../ui/shortcuts"
import { C5FocusHeader, DiagramInNote, phoneBleed } from "./c5Samples"
import { GuideGroup, GuideLabel, GuideValue } from "./parts"

// The Canvas group: the tool and zoom islands that float on a drawing or a
// diagram (desktop and phone), the canvas colours in the drawing font, and
// Go to file and Commands, then put together as C5's full-screen drawing and
// diagram.

// Hover and focus drawn on purpose, so the page shows those states at rest.
const hover = "bg-seg"
const focus = "outline-2 outline-offset-2 outline-ring outline-solid"

const noop = () => {}

/** Desktop islands are wider than a phone's column: they scroll sideways there, keeping room for their shadow. */
function Fit({ children }: { children: ReactNode }) {
  return <div className="-m-1 max-w-[calc(100%+8px)] overflow-x-auto p-1">{children}</div>
}

/** The C5 project's files, most recent first. */
const files: QuickOpenFile[] = [
  { path: "docs/customer-model.mdx", kind: "note" },
  { path: "art/flow.excalidraw", kind: "drawing" },
  { path: "flows/signup.d2", kind: "diagram" },
  { path: "docs/onboarding.mdx", kind: "note" },
  { path: "docs/pricing.md", kind: "note" },
  { path: "flows/billing.d2", kind: "diagram" },
  { path: "docs/roadmap.md", kind: "note" },
  { path: "README.md", kind: "note" },
]

const allTools = Object.values(canvasTools)

/** An island that works: pick a tool, or one from More tools. */
function LiveToolIsland({ size = "default", className }: { size?: IslandSize; className?: string }) {
  const [tool, setTool] = useState("select")
  const shown = islandTools[size]
  const more = allTools.filter((candidate) => !shown.includes(candidate))
  return (
    <CanvasIsland size={size} className={className}>
      <ToolGroup value={tool} onValueChange={setTool} aria-label="Drawing tools">
        {shown.map((candidate) => (
          <ToolButton key={candidate.id} tool={candidate} />
        ))}
      </ToolGroup>
      <MoreTools entries={toolEntries(more, setTool)} active={more.some((candidate) => candidate.id === tool)} />
    </CanvasIsland>
  )
}

function LiveZoom() {
  const [zoom, setZoom] = useState(1)
  const step = (by: number) => setZoom((current) => Math.min(3, Math.max(0.1, Math.round((current + by) * 10) / 10)))
  return (
    <ZoomControl
      zoom={zoom}
      onZoomOut={zoom > 0.1 ? () => step(-0.1) : undefined}
      onZoomIn={zoom < 3 ? () => step(0.1) : undefined}
      onReset={() => setZoom(1)}
    />
  )
}

function IslandDemos() {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <GuideLabel>Tool island</GuideLabel>
      <Fit>
        <LiveToolIsland />
      </Fit>
      <GuideValue>Tools 34 square, radius 8, 16px icons; island padding 4, radius 10, island shadow and ring. Point at a tool for its name and key.</GuideValue>
      <GuideLabel>Tool states</GuideLabel>
      <CanvasIsland>
        <ToolGroup value="select" onValueChange={noop} aria-label="Tool states">
          <ToolButton tool={canvasTools.hand} />
          <ToolButton tool={canvasTools.rectangle} className={hover} />
          <ToolButton tool={canvasTools.select} />
          <ToolButton tool={canvasTools.diamond} className={focus} />
          <ToolButton tool={canvasTools.text} disabled />
        </ToolGroup>
        <MoreTools entries={toolEntries([canvasTools.line], noop)} />
        <MoreTools entries={toolEntries([canvasTools.line], noop)} active />
      </CanvasIsland>
      <GuideValue>Default, hover (seg), current (toolOn), focus, disabled; More tools, and More tools while one of its tools is current.</GuideValue>
      <GuideLabel>Zoom</GuideLabel>
      <div className="flex flex-wrap items-center gap-3">
        <LiveZoom />
        <ZoomControl zoom={0.1} onZoomIn={noop} />
      </div>
      <GuideValue>The percentage resets to 100%; at a limit its button is disabled (right: at 10%, without reset).</GuideValue>
    </div>
  )
}

/** The bottom of C5's phone drawing screen (390 wide): the island 22 from the bottom, 40px tools. */
function PhoneIsland() {
  return (
    <div className="flex w-full max-w-[390px] flex-col gap-3">
      <GuideLabel>Phone island at 390</GuideLabel>
      <DottedPage className={cn("relative h-[444px] min-h-0 w-full overflow-hidden rounded-[4px]", phoneBleed)}>
        <svg
          width="390"
          height="444"
          viewBox="0 400 390 444"
          aria-label="Drawing sample: project and agent"
          className="absolute top-0 left-0 font-[family-name:Excalifont,cursive]"
        >
          <ellipse cx="200" cy="470" rx="100" ry="54" className="fill-pastel-yellow stroke-ink" strokeWidth="2" />
          <text x="200" y="478" textAnchor="middle" fontSize="22" className="fill-ink">
            Project
          </text>
          <path d="M160 600 L240 552 L320 600 L240 648 Z" className="fill-pastel-green stroke-ink" strokeWidth="2" strokeLinejoin="round" />
          <text x="240" y="607" textAnchor="middle" fontSize="19" className="fill-ink">
            Agent?
          </text>
        </svg>
        <LiveToolIsland size="touch" className="absolute bottom-[22px] left-1/2 -translate-x-1/2" />
      </DottedPage>
      <GuideValue>Tools 40 square, radius 9, 20px icons; island radius 14 with a border. More tools holds the rest.</GuideValue>
    </div>
  )
}

/** The style guide's canvas sample: shapes in the fills with ink, connectors in accentInk, a note in inkSoft. */
function CanvasColours() {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <GuideLabel>Canvas colours</GuideLabel>
      <svg width="420" height="120" viewBox="0 0 420 120" aria-label="Canvas colours" className="max-w-full font-[family-name:Excalifont,cursive]">
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
      <GuideLabel>Diagram in a note</GuideLabel>
      <DottedPage className="flex h-[150px] min-h-0 items-center justify-center rounded-[10px] border border-border">
        <DiagramInNote />
      </DottedPage>
      <GuideValue>D2 boxes in d2Fill and d2Fill2 on the dotted page, as a note shows a diagram.</GuideValue>
    </div>
  )
}

/** A few of the editor's commands, for the Commands samples. */
const commands: QuickOpenCommand[] = [
  { label: "Toggle explorer", shortcut: commandShortcut("b", isApplePlatform()), run: noop },
  { label: "Focus", shortcut: commandShortcut(".", isApplePlatform()), run: noop },
  { label: "New note", run: noop },
  { label: "New drawing", run: noop },
  { label: "New diagram", run: noop },
  { label: "Duplicate", shortcut: commandShortcut("d", isApplePlatform()), run: noop },
  { label: "Settings", run: noop },
]

/**
 * The palette held open as C5 draws it: the real QuickOpen, laid out in
 * place (its portal renders here and the popup is static) and inert, so it
 * neither takes focus nor reacts to the pointer. "Try it" has the live one.
 */
function QuickOpenSpecimen({ mode, query }: { mode: QuickOpenMode; query: string }) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  return (
    <div inert ref={setContainer} data-specimen={`quick-open-${mode}`} className="w-full max-w-[560px]">
      {container && (
        <QuickOpen
          open
          modal={false}
          container={container}
          files={files}
          commands={commands}
          mode={mode}
          defaultQuery={query}
          onOpenChange={noop}
          onOpen={noop}
          className="static! max-w-none! translate-none!"
        />
      )}
    </div>
  )
}

function QuickOpenDemo() {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<QuickOpenMode>("files")
  const [chosen, setChosen] = useState<string | null>(null)
  const opener = useRef<HTMLButtonElement>(null)
  const show = (next: QuickOpenMode) => {
    setMode(next)
    setOpen(true)
  }
  return (
    <div className="flex w-full max-w-[560px] flex-col gap-3">
      <GuideLabel>Go to file</GuideLabel>
      <QuickOpenSpecimen mode="files" query="flo" />
      <GuideValue>560 wide, padding 8, radius 12, panel shadow; field 38 high with a 2px accent border; rows 34 high, radius 8, selected in accentSoft.</GuideValue>
      <GuideLabel>Commands</GuideLabel>
      <QuickOpenSpecimen mode="commands" query="" />
      <GuideValue>
        The same panel: a command's shortcut at the row's right end. {commandShortcut("k", isApplePlatform()).label} and{" "}
        {commandShortcut("p", isApplePlatform()).label} switch between the two.
      </GuideValue>
      <GuideLabel>Try it</GuideLabel>
      <div className="flex flex-wrap items-center gap-3">
        <Button ref={opener} variant="outline" className="pointer-coarse:h-10" onClick={() => show("files")}>
          Open Go to file
        </Button>
        <Button variant="outline" className="pointer-coarse:h-10" onClick={() => show("commands")}>
          Open Commands
        </Button>
        <p aria-live="polite" className="leading-none">
          <GuideValue>{chosen ?? "Choose a file or a command to see it here"}</GuideValue>
        </p>
      </div>
      <QuickOpen
        open={open}
        onOpenChange={setOpen}
        finalFocus={opener}
        files={files}
        commands={commands.map((command) => ({ ...command, run: () => setChosen(`Ran ${command.label}`) }))}
        mode={mode}
        onModeChange={setMode}
        onOpen={(path) => setChosen(`Opened ${path}`)}
      />
    </div>
  )
}

/**
 * A 1440 by 900 screen in focus mode: the drawing or diagram fills it, the
 * tools at the top centre, the header at the top right, zoom at the bottom
 * left.
 */
function FullScreen({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <GuideLabel>{label}</GuideLabel>
      <DottedPage className="relative h-[900px] min-h-0 w-full max-w-[1440px] overflow-hidden rounded-[4px]">
        {children}
        <C5ToolIsland />
        <C5FocusHeader names="canvas" className="absolute top-4 right-4" />
        <ZoomControl zoom={1} onZoomOut={noop} onZoomIn={noop} onReset={noop} className="absolute bottom-4 left-4" />
      </DottedPage>
    </div>
  )
}

/** C5 screen 4: the sign-up flow sketch, full screen. */
function FullScreenDrawing() {
  return (
    <FullScreen label="C5 drawing, full screen">
      <svg
        width="1440"
        height="900"
        viewBox="0 0 1440 900"
        aria-label="Drawing sample: sign-up flow sketch"
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
        <path d="M768 540 L858 480 L948 540 L858 600 Z" className="fill-pastel-green stroke-ink" strokeWidth="2" strokeLinejoin="round" />
        <text x="858" y="548" textAnchor="middle" fontSize="22" className="fill-ink">
          Agent?
        </text>
        <path d="M672 358 C 720 350, 740 352, 766 358" fill="none" className="stroke-ink" strokeWidth="2" strokeLinecap="round" />
        <path d="M756 350 L768 358 L756 366" fill="none" className="stroke-ink" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M880 422 C 876 445, 868 460, 862 478" fill="none" className="stroke-ink" strokeWidth="2" strokeLinecap="round" />
        <path d="M853 470 L861 480 L870 471" fill="none" className="stroke-ink" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <text x="1000" y="550" fontSize="22" className="fill-ink-soft">
          connect Claude
        </text>
        <rect x="1180" y="620" width="240" height="120" rx="18" className="fill-pastel-blue stroke-ink" strokeWidth="2" />
        {/* The drawing font runs wider than the design's serif: 22 keeps the design's margins in the box. */}
        <text x="1300" y="686" textAnchor="middle" fontSize="22" className="fill-ink">
          Invite a teammate
        </text>
        <path d="M940 570 C 1040 620, 1110 650, 1176 670" fill="none" className="stroke-ink" strokeWidth="2" strokeLinecap="round" />
        <path d="M1165 662 L1177 670 L1164 676" fill="none" className="stroke-ink" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M630 580 C 660 620, 720 635, 760 580" fill="none" className="stroke-accent-ink" strokeWidth="2" strokeLinecap="round" strokeDasharray="6 8" />
        {/* Ends where the design's serif ends, clear of the arc, in the wider drawing font. */}
        <text x="622" y="620" textAnchor="end" fontSize="20" className="fill-accent-ink">
          first save
        </text>
      </svg>
    </FullScreen>
  )
}

/** C5 screen 5: the signup diagram full screen, its edges labelled. */
function FullScreenDiagram() {
  return (
    <FullScreen label="C5 diagram, full screen">
      <svg
        width="1440"
        height="900"
        viewBox="0 0 1440 900"
        role="img"
        aria-label="Diagram sample: user signs up with the app, which emails a link through auth"
        className="absolute top-0 left-0 font-[family-name:Excalifont,cursive]"
      >
        <rect x="470" y="290" width="170" height="80" rx="12" className="fill-d2-fill stroke-ink" strokeWidth="2" />
        <text x="555" y="338" textAnchor="middle" fontSize="24" className="fill-ink">
          user
        </text>
        <rect x="790" y="290" width="170" height="80" rx="12" className="fill-d2-fill stroke-ink" strokeWidth="2" />
        <text x="875" y="338" textAnchor="middle" fontSize="24" className="fill-ink">
          app
        </text>
        <rect x="790" y="510" width="170" height="80" rx="12" className="fill-d2-fill2 stroke-ink" strokeWidth="2" />
        <text x="875" y="558" textAnchor="middle" fontSize="24" className="fill-ink">
          auth
        </text>
        <path d="M640 330H782M774 322l8 8-8 8" fill="none" className="stroke-ink" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <text x="711" y="316" textAnchor="middle" fontSize="18" className="fill-ink-soft">
          sign up
        </text>
        <path d="M875 370V502M867 494l8 8 8-8" fill="none" className="stroke-ink" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <text x="890" y="442" fontSize="18" className="fill-ink-soft">
          email link
        </text>
        <path d="M790 550H555V378M547 386l8-8 8 8" fill="none" className="stroke-ink" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <text x="670" y="576" textAnchor="middle" fontSize="18" className="fill-ink-soft">
          signed in
        </text>
      </svg>
    </FullScreen>
  )
}

/** The desktop island as C5 draws it: the eight tools, no More tools. */
function C5ToolIsland() {
  const [tool, setTool] = useState("select")
  return (
    <CanvasIsland className="absolute top-4 left-1/2 -translate-x-1/2">
      <ToolGroup value={tool} onValueChange={setTool} aria-label="Drawing tools">
        {islandTools.default.map((candidate) => (
          <ToolButton key={candidate.id} tool={candidate} />
        ))}
      </ToolGroup>
    </CanvasIsland>
  )
}

export function CanvasSection() {
  // The samples use the drawing font, which loads on demand.
  useEffect(() => {
    ensureGeneratedNativeFont().catch(() => {
      /* The samples fall back to a cursive font. */
    })
  }, [])
  return (
    <GuideGroup title="Canvas">
      <div className="flex flex-col gap-7">
        <div className="grid grid-cols-1 gap-7 lg:grid-cols-3">
          <IslandDemos />
          <CanvasColours />
          <PhoneIsland />
        </div>
        <QuickOpenDemo />
        <FullScreenDrawing />
        <FullScreenDiagram />
      </div>
    </GuideGroup>
  )
}
