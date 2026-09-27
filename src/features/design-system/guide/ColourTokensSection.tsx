import { getPaletteColors, tokenProperty, useAppearance, type PaletteColors } from "@/features/appearance"
import { GuideCard } from "./parts"

// Every colour token, grouped as the style guide groups them. The chip paints
// the live CSS variable; the caption is the active palette's value from
// palettes.ts, so the two disagreeing shows up here (and in the browser spec).
// As in the style guide, a chip is 44 high inside its 1px border.
const GROUPS: readonly { title: string; keys: readonly (keyof PaletteColors)[] }[] = [
  { title: "Surfaces", keys: ["bg", "dot", "panel", "panelBorder", "field", "seg", "lineHi"] },
  { title: "Text", keys: ["text", "body", "muted", "dim", "faint"] },
  { title: "Accent", keys: ["accent", "accentText", "accentSoft", "accentSoftText", "accentInk"] },
  { title: "Status", keys: ["ok", "dirty", "danger", "warnBg", "warnText"] },
  { title: "Files and code", keys: ["note", "drawing", "diagram", "codeHead", "codeKey", "codeStr", "codeKw"] },
  { title: "Canvas", keys: ["ink", "inkSoft", "d2Fill", "d2Fill2", "pastelBlue", "pastelYellow", "pastelGreen", "pastelPink", "island", "toolOn"] },
]

export function ColourTokensSection() {
  const { appearance } = useAppearance()
  const colors = getPaletteColors(appearance)
  return (
    <GuideCard title="Colour tokens">
      <div className="flex flex-col gap-4">
        {GROUPS.map((group) => (
          <div key={group.title} className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-4">
            <h3 className="w-[110px] shrink-0 text-[13px] font-semibold text-muted-foreground sm:pt-3">{group.title}</h3>
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-3.5 sm:flex sm:flex-wrap" aria-label={group.title}>
              {group.keys.map((key) => (
                <li key={key} data-token={key} className="flex min-w-0 flex-col gap-1.5 sm:w-[120px]">
                  <span
                    aria-hidden="true"
                    className="box-content h-11 rounded-tile border border-panel-border"
                    style={{ background: `var(${tokenProperty(key)})` }}
                  />
                  <span className="truncate font-mono text-xs leading-[normal] text-muted-foreground">{key}</span>
                  <span className="font-mono text-[11px] leading-[normal] text-dim">{colors[key]}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </GuideCard>
  )
}
