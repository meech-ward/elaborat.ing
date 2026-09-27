import { createContext, useContext, type ComponentProps, type ReactElement } from "react"
import { cva, type VariantProps } from "class-variance-authority"
import {
  ArrowRight,
  Circle,
  Ellipsis,
  Eraser,
  Hand,
  ImageIcon,
  Minus,
  MousePointer2,
  Pencil,
  Square,
  Type,
  type LucideIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { cn } from "@/lib/utils"
import { ActionMenu, type MenuEntry } from "./ActionMenu"
import { Hint } from "./Hint"
import { SharpDiamond } from "./SharpDiamond"

// The canvas's floating islands: the tool picker and the zoom control that
// sit on a drawing or a diagram, in the palette's island colours.
// CanvasIsland is the surface (no shadcn primitive fits: it is a plain
// surface, like a card with the island's own shadow and radius); the tools
// in it are a shadcn ToggleGroup, one pressed at a time, and More tools is a
// shadcn dropdown menu (ActionMenu) on a Button.

export type IslandSize = "default" | "touch"

const IslandSizeContext = createContext<IslandSize>("default")

/**
 * The island surface. `default` is the desktop island: padding 4, radius 10,
 * a small shadow and a 1px ring. `touch` is the phone's: radius 14, a 1px
 * border and a softer, lower shadow. Buttons inside take the island's size.
 */
export const canvasIslandVariants = cva("inline-flex w-fit items-center gap-0.5 bg-island p-1 text-tool-ink", {
  variants: {
    size: {
      default: "rounded-tile shadow-island",
      touch: "rounded-panel border border-border shadow-[0_6px_18px_var(--shadow)]",
    },
  },
  defaultVariants: { size: "default" },
})

export function CanvasIsland({
  size = "default",
  className,
  ...props
}: ComponentProps<"div"> & VariantProps<typeof canvasIslandVariants>) {
  const resolved = size ?? "default"
  return (
    <IslandSizeContext value={resolved}>
      <div data-slot="canvas-island" data-size={resolved} className={cn(canvasIslandVariants({ size: resolved }), className)} {...props} />
    </IslandSizeContext>
  )
}

/**
 * A tool button's look: 34 square with radius 8 and a 16px icon on desktop,
 * 40 with radius 9 and a 20px icon on touch screens; toolInk, and the
 * pressed tool (or an open More tools menu's current tool, data-active) on
 * toolOn with toolOnInk. The desktop size is 40 square on touch screens
 * too, like every Button, so the island's tools and its More tools and zoom
 * buttons stay one size.
 */
export const toolButtonVariants = cva(
  "inline-flex min-w-0 shrink-0 items-center justify-center bg-transparent p-0 font-normal text-tool-ink hover:bg-seg hover:text-tool-ink aria-pressed:bg-tool-on aria-pressed:text-tool-on-ink data-[active=true]:bg-tool-on data-[active=true]:text-tool-on-ink",
  {
    variants: {
      size: {
        default: "size-[34px] rounded-tool pointer-coarse:size-10 [&_svg:not([class*='size-'])]:size-4",
        touch: "size-10 rounded-button [&_svg:not([class*='size-'])]:size-5",
      },
    },
    defaultVariants: { size: "default" },
  },
)

/** A canvas tool: its name, its key and its Lucide icon. */
export interface CanvasTool {
  id: string
  label: string
  /** The key that picks it, shown in the hint. */
  shortcut?: string
  icon: LucideIcon
}

/** The drawing tools, with the keys the drawing editor uses. */
export const canvasTools = {
  hand: { id: "hand", label: "Hand", shortcut: "H", icon: Hand },
  select: { id: "select", label: "Select", shortcut: "V", icon: MousePointer2 },
  rectangle: { id: "rectangle", label: "Rectangle", shortcut: "R", icon: Square },
  diamond: { id: "diamond", label: "Diamond", shortcut: "D", icon: SharpDiamond },
  ellipse: { id: "ellipse", label: "Ellipse", shortcut: "O", icon: Circle },
  arrow: { id: "arrow", label: "Arrow", shortcut: "A", icon: ArrowRight },
  line: { id: "line", label: "Line", shortcut: "L", icon: Minus },
  draw: { id: "draw", label: "Draw", shortcut: "P", icon: Pencil },
  text: { id: "text", label: "Text", shortcut: "T", icon: Type },
  image: { id: "image", label: "Image", icon: ImageIcon },
  eraser: { id: "eraser", label: "Eraser", shortcut: "E", icon: Eraser },
} satisfies Record<string, CanvasTool>

const t = canvasTools

/** Which tools each island shows; the rest go in More tools. */
export const islandTools: Record<IslandSize, readonly CanvasTool[]> = {
  default: [t.hand, t.select, t.rectangle, t.diamond, t.ellipse, t.arrow, t.draw, t.text],
  touch: [t.hand, t.select, t.rectangle, t.arrow, t.draw, t.text],
}

/**
 * The tools as one choice: a ToggleGroup where exactly one tool is pressed
 * (pressing the current tool again keeps it). Arrow keys move between tools.
 */
export function ToolGroup({
  value,
  onValueChange,
  className,
  ...props
}: Omit<ComponentProps<typeof ToggleGroup>, "value" | "defaultValue" | "onValueChange" | "multiple" | "variant" | "size"> & {
  value: string
  onValueChange: (tool: string) => void
}) {
  return (
    <ToggleGroup
      value={[value]}
      onValueChange={(next) => {
        if (next[0]) onValueChange(next[0])
      }}
      spacing={0.5}
      className={className}
      {...props}
    />
  )
}

/** One tool in a ToolGroup, named by its label, with a hint on desktop. */
export function ToolButton({
  tool,
  className,
  ...props
}: Omit<ComponentProps<typeof ToggleGroupItem>, "value" | "children"> & { tool: CanvasTool }) {
  const size = useContext(IslandSizeContext)
  const Icon = tool.icon
  const button = (
    <ToggleGroupItem value={tool.id} aria-label={tool.label} className={cn(toolButtonVariants({ size }), className)} {...props}>
      <Icon aria-hidden="true" />
    </ToggleGroupItem>
  )
  // Hints need a pointer that hovers; touch islands go without.
  return size === "touch" ? button : <Hint label={tool.label} shortcut={tool.shortcut}>{button}</Hint>
}

/**
 * The More tools button and its menu, for the tools an island has no room
 * for. `active` shows it pressed while one of its tools is the current one.
 * `open`, `modal` and `contentProps` pass to the menu (the style guide uses
 * them to hold it open in place).
 */
export function MoreTools({
  entries,
  active = false,
  className,
  ...menu
}: Omit<ComponentProps<typeof ActionMenu>, "trigger"> & { active?: boolean; className?: string }) {
  const size = useContext(IslandSizeContext)
  const trigger: ReactElement = (
    <Button variant="ghost" aria-label="More tools" data-active={active} className={cn(toolButtonVariants({ size }), className)}>
      <Ellipsis aria-hidden="true" />
    </Button>
  )
  return (
    <ActionMenu
      entries={entries}
      trigger={trigger}
      {...menu}
      contentProps={{ side: size === "touch" ? "top" : "bottom", align: "end", sideOffset: 8, ...menu.contentProps }}
    />
  )
}

/** Menu entries that pick tools, for MoreTools. */
export function toolEntries(tools: readonly CanvasTool[], choose: (tool: string) => void): MenuEntry[] {
  return tools.map((tool) => ({ label: tool.label, shortcut: tool.shortcut, onSelect: () => choose(tool.id) }))
}

/**
 * The zoom island: − and + as tool buttons around the zoom as a percentage
 * (52 wide, 13px mono). With `onReset`, the percentage is a button that sets
 * 100%. A missing onZoomOut or onZoomIn disables that button (at the limit).
 */
export function ZoomControl({
  zoom,
  onZoomOut,
  onZoomIn,
  onReset,
  size = "default",
  className,
}: {
  /** 1 is 100%. */
  zoom: number
  onZoomOut?: () => void
  onZoomIn?: () => void
  onReset?: () => void
  size?: IslandSize
  className?: string
}) {
  const percent = `${Math.round(zoom * 100)}%`
  const tool = toolButtonVariants({ size })
  // − and + are text, as C5 draws them; 16px gives the drawn glyphs' width.
  const glyph = "text-base"
  const value = cn("w-[52px] text-center font-mono text-[13px] text-tool-ink", size === "touch" ? "h-10" : "h-[34px]")
  return (
    <CanvasIsland size={size} role="group" aria-label="Zoom" className={className}>
      <Button variant="ghost" aria-label="Zoom out" disabled={!onZoomOut} onClick={onZoomOut} className={cn(tool, glyph)}>
        −
      </Button>
      {onReset ? (
        <Button
          variant="ghost"
          aria-label={`Reset zoom, now ${percent}`}
          onClick={onReset}
          className={cn(value, "min-w-0 rounded-tool p-0 font-normal hover:bg-seg hover:text-tool-ink")}
        >
          {percent}
        </Button>
      ) : (
        <output aria-label="Zoom level" className={cn(value, "inline-flex items-center justify-center")}>
          {percent}
        </output>
      )}
      <Button variant="ghost" aria-label="Zoom in" disabled={!onZoomIn} onClick={onZoomIn} className={cn(tool, glyph)}>
        +
      </Button>
    </CanvasIsland>
  )
}
