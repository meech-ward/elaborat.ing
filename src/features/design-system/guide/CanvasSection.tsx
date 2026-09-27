import { useEffect, useRef, useState, type ReactNode } from "react"
import { DottedPage } from "@/components/panel"
import { Button } from "@/components/ui/button"
import { ensureGeneratedNativeFont } from "@/features/drawings"
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
import { QuickOpen, type QuickOpenFile } from "../ui/QuickOpen"
import { GuideGroup, GuideLabel, GuideValue } from "./parts"

// The Canvas group: the tool and zoom islands that float on a drawing or a
// diagram (desktop and phone), the canvas colours in the drawing font, and
// Go to file, then put together as C5's full-screen drawing.

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
      <DottedPage className="relative h-[444px] min-h-0 w-full overflow-hidden rounded-[4px]">
        <svg
          width="390"
          height="444"
          viewBox="0 400 390 444"
          aria-label="Drawing sample: project and agent"
          className="absolute top-0 left-0 font-[family-name:Excalifont,cursive]"
        >
          <path d="M270 342 C 262 380, 244 400, 232 418" fill="none" className="stroke-ink" strokeWidth="2" strokeLinecap="round" />
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
        <svg width="420" height="120" viewBox="0 0 420 120" aria-label="Diagram sample: user, app and auth" className="max-w-full font-[family-name:Excalifont,cursive]">
          <rect x="10" y="36" width="96" height="48" rx="10" className="fill-d2-fill stroke-ink" strokeWidth="2" />
          <text x="58" y="66" textAnchor="middle" fontSize="18" className="fill-ink">
            user
          </text>
          <rect x="162" y="36" width="96" height="48" rx="10" className="fill-d2-fill stroke-ink" strokeWidth="2" />
          <text x="210" y="66" textAnchor="middle" fontSize="18" className="fill-ink">
            app
          </text>
          <rect x="314" y="36" width="96" height="48" rx="10" className="fill-d2-fill2 stroke-ink" strokeWidth="2" />
          <text x="362" y="66" textAnchor="middle" fontSize="18" className="fill-ink">
            auth
          </text>
          <path d="M106 60H158M152 54l6 6-6 6M258 60H310M304 54l6 6-6 6" fill="none" className="stroke-ink" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </DottedPage>
      <GuideValue>D2 boxes in d2Fill and d2Fill2 on the dotted page, as a note shows a diagram.</GuideValue>
    </div>
  )
}

/**
 * Go to file held open as C5 draws it, typed "flo": the real QuickOpen,
 * laid out in place (its portal renders here and the popup is static) and
 * inert, so it neither takes focus nor reacts to the pointer. "Try it" has
 * the live one.
 */
function QuickOpenSpecimen() {
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  return (
    <div inert ref={setContainer} data-specimen="quick-open" className="w-full max-w-[560px]">
      {container && (
        <QuickOpen
          open
          modal={false}
          container={container}
          files={files}
          defaultQuery="flo"
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
  const [opened, setOpened] = useState<string | null>(null)
  const opener = useRef<HTMLButtonElement>(null)
  return (
    <div className="flex w-full max-w-[560px] flex-col gap-3">
      <GuideLabel>Go to file</GuideLabel>
      <QuickOpenSpecimen />
      <GuideValue>560 wide, padding 8, radius 12, panel shadow; field 38 high with a 2px accent border; rows 34 high, radius 8, selected in accentSoft.</GuideValue>
      <GuideLabel>Try it</GuideLabel>
      <div className="flex flex-wrap items-center gap-3">
        <Button ref={opener} variant="outline" className="pointer-coarse:h-10" onClick={() => setOpen(true)}>
          Open Go to file
        </Button>
        <p aria-live="polite" className="leading-none">
          <GuideValue>{opened ? `Opened ${opened}` : "Choose a file to see it here"}</GuideValue>
        </p>
      </div>
      <QuickOpen
        open={open}
        onOpenChange={setOpen}
        finalFocus={opener}
        files={files}
        onOpen={(path, { toSide }) => setOpened(toSide ? `${path} to the side` : path)}
      />
    </div>
  )
}

/** C5 screen 4 without the editor chrome: the drawing full screen, tools top centre, zoom bottom left. */
function FullScreenDrawing() {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <GuideLabel>C5 drawing, full screen</GuideLabel>
      <DottedPage className="relative h-[900px] min-h-0 w-full max-w-[1440px] overflow-hidden rounded-[4px]">
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
            connect an agent
          </text>
          <rect x="1180" y="620" width="240" height="120" rx="18" className="fill-pastel-blue stroke-ink" strokeWidth="2" />
          <text x="1300" y="686" textAnchor="middle" fontSize="24" className="fill-ink">
            Invite a teammate
          </text>
          <path d="M940 570 C 1040 620, 1110 650, 1176 670" fill="none" className="stroke-ink" strokeWidth="2" strokeLinecap="round" />
          <path d="M1165 662 L1177 670 L1164 676" fill="none" className="stroke-ink" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M630 580 C 660 620, 720 635, 760 580" fill="none" className="stroke-accent-ink" strokeWidth="2" strokeLinecap="round" strokeDasharray="6 8" />
          <text x="550" y="620" fontSize="20" className="fill-accent-ink">
            first save
          </text>
        </svg>
        <C5ToolIsland />
        <ZoomControl zoom={1} onZoomOut={noop} onZoomIn={noop} onReset={noop} className="absolute bottom-4 left-4" />
      </DottedPage>
    </div>
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
        <div className="grid gap-7 lg:grid-cols-3">
          <IslandDemos />
          <CanvasColours />
          <PhoneIsland />
        </div>
        <QuickOpenDemo />
        <FullScreenDrawing />
      </div>
    </GuideGroup>
  )
}
