import { useState } from "react"
import { Minimize2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { FloatingPanel } from "../ui/FloatingPanel"
import { IconButton } from "../ui/IconButton"
import { SaveButton } from "../ui/SaveButton"
import { commandShortcut, isApplePlatform } from "../ui/shortcuts"
import { ViewSwitch } from "../ui/ViewSwitch"
import type { EditorView, ViewNames } from "../ui/views"

// Pieces of the C5 screens that more than one section of the style guide
// shows: the focus mode header, the diagram a note embeds, and the class
// that lets a phone sample span a phone's whole width.

/**
 * A phone sample is 390 wide. On a phone the page's and the card's padding
 * would squeeze it, so there it spans the screen, centred, as the real
 * screen would. (Its card lets it out: see StyleGuidePage.)
 */
export const phoneBleed = "max-sm:relative max-sm:left-1/2 max-sm:w-[min(390px,100vw)] max-sm:max-w-none max-sm:-translate-x-1/2 max-sm:rounded-none"

/**
 * C5 screens 4 and 5's header, full screen: the view switch, Save and Exit
 * full screen on a floating panel, 44 high with radius 12. A drawing's or
 * diagram's views are Code, Split and Canvas (`names="canvas"`).
 */
export function C5FocusHeader({ names = "note", className }: { names?: ViewNames; className?: string }) {
  const [view, setView] = useState<EditorView>("rendered")
  const focus = commandShortcut(".", isApplePlatform())
  return (
    <FloatingPanel className={cn("flex h-11 items-center gap-1.5 rounded-menu px-1.5 pointer-coarse:h-[52px]", className)}>
      <ViewSwitch value={view} onValueChange={setView} names={names} />
      <SaveButton />
      <IconButton label="Exit full screen" shortcut={focus.label} keyShortcuts={focus.aria}>
        <Minimize2 />
      </IconButton>
    </FloatingPanel>
  )
}

/** The signup diagram as a note embeds it: three D2 boxes, 420 by 120, in the drawing font. */
export function DiagramInNote({ className }: { className?: string }) {
  return (
    <svg
      width="420"
      height="120"
      viewBox="0 0 420 120"
      role="img"
      aria-label="Diagram sample: user, app and auth"
      className={cn("max-w-full font-[family-name:Excalifont,cursive]", className)}
    >
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
  )
}
