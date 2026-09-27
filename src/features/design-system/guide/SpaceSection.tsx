import { Code, Columns2, Eye, Maximize2, Plus, Search } from "lucide-react"
import { cn } from "@/lib/utils"
import { GuideCard, GuideValue } from "./parts"

// Space, radius, elevation and icons. The boxes use the Tailwind values the
// tokens map to (index.css): spacing 1 to 8, rounded-row to rounded-pill,
// shadow-panel and shadow-island.
const SPACE: readonly { px: number; className: string }[] = [
  { px: 4, className: "size-1" },
  { px: 6, className: "size-1.5" },
  { px: 8, className: "size-2" },
  { px: 12, className: "size-3" },
  { px: 16, className: "size-4" },
  { px: 24, className: "size-6" },
  { px: 32, className: "size-8" },
]

const RADII: readonly { label: string; className: string }[] = [
  { label: "7 rows", className: "rounded-row" },
  { label: "9 buttons", className: "rounded-button" },
  { label: "12 menus", className: "rounded-menu" },
  { label: "14 panels", className: "rounded-panel" },
  { label: "pills", className: "rounded-pill" },
]

const ICONS = [
  { name: "plus", Icon: Plus },
  { name: "code", Icon: Code },
  { name: "columns-2", Icon: Columns2 },
  { name: "eye", Icon: Eye },
  { name: "maximize-2", Icon: Maximize2 },
  { name: "search", Icon: Search },
]

export function SpaceSection() {
  return (
    <GuideCard title="Space, radius, elevation, icons">
      <div className="flex flex-wrap items-end gap-3.5">
        {SPACE.map(({ px, className }) => (
          <div key={px} className="flex flex-col items-center gap-1.5">
            <div aria-hidden="true" className={cn("rounded-[3px] border border-primary bg-accent-soft", className)} />
            <GuideValue>{px}</GuideValue>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-3.5">
        {RADII.map(({ label, className }) => (
          <div key={label} className="flex flex-col items-center gap-1.5">
            <div aria-hidden="true" className={cn("h-11 w-16 border border-panel-border bg-seg", className)} />
            <GuideValue>{label}</GuideValue>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-[18px]">
        <div className="flex h-[60px] w-[150px] items-center justify-center rounded-panel border border-panel-border bg-panel shadow-panel">
          <GuideValue>panel · 0 10 30</GuideValue>
        </div>
        <div className="flex h-11 items-center rounded-[10px] bg-island px-3 shadow-island">
          <GuideValue>canvas island</GuideValue>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-4 text-foreground">
        {ICONS.map(({ name, Icon }) => (
          <Icon key={name} aria-hidden="true" className="size-4" strokeWidth={2} />
        ))}
        <GuideValue>Lucide, 16 px in the app and 20 px on phones, 2 px stroke</GuideValue>
      </div>
    </GuideCard>
  )
}
