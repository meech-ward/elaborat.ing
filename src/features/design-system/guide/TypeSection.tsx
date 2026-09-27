import { useEffect, type ReactNode } from "react"
import { ensureGeneratedNativeFont } from "@/features/drawings"
import { GuideCard, GuideValue } from "./parts"

// The type scale: each sample in its size, weight and colour, with its spec.
// Line heights are the fonts' own (normal) unless the spec gives one.
const SAMPLES: readonly { spec: string; sample: ReactNode; className: string }[] = [
  { spec: "H1 · 32 / 700", sample: "Customer model", className: "text-[32px] leading-[normal] font-bold" },
  { spec: "H2 · 21 / 600", sample: "Steps", className: "text-[21px] leading-[normal] font-semibold" },
  {
    spec: "Body · 15.5 / 1.6",
    sample: "How a customer moves from sign-up to their first project.",
    className: "text-[15.5px] leading-[1.6] text-body",
  },
  { spec: "UI · 13 / 500", sample: "customer-model.mdx", className: "text-[13px] leading-[normal] font-medium" },
  { spec: "Label · 11 / 600", sample: "Open editors", className: "text-[11px] leading-[normal] font-semibold tracking-[0.07em] text-dim uppercase" },
  {
    spec: "Code · 13 / 22",
    sample: (
      <>
        <span className="text-code-key">{"<Drawing"}</span> src=<span className="text-code-str">"art/flow.excalidraw"</span>{" "}
        <span className="text-code-key">{"/>"}</span>
      </>
    ),
    className: "font-mono text-[13px] leading-[22px]",
  },
  { spec: "Canvas · Excalifont", sample: "Sign up", className: "font-[family-name:Excalifont,cursive] text-[26px] leading-[normal] text-ink" },
]

export function TypeSection() {
  // The canvas sample uses the drawing font, which loads on demand.
  useEffect(() => {
    ensureGeneratedNativeFont().catch(() => {
      /* The sample falls back to a cursive font. */
    })
  }, [])
  return (
    <GuideCard title="Type">
      {SAMPLES.map(({ spec, sample, className }) => (
        <div key={spec} className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-4">
          <GuideValue className="shrink-0 sm:w-[120px]">{spec}</GuideValue>
          <p className={className}>{sample}</p>
        </div>
      ))}
    </GuideCard>
  )
}
