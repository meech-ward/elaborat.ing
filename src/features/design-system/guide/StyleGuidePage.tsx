import { DottedPage } from "@/components/panel"
import { useAppearance } from "@/features/appearance"
import { palettes } from "@/features/appearance/palettes"
import { AppearancePicker } from "./AppearancePicker"
import { CanvasSection } from "./CanvasSection"
import { ColourTokensSection } from "./ColourTokensSection"
import { ControlsSection } from "./ControlsSection"
import { EditorChromeSection } from "./EditorChromeSection"
import { NavigationSection } from "./NavigationSection"
import { GuideCard } from "./parts"
import { SpaceSection } from "./SpaceSection"
import { TypeSection } from "./TypeSection"

/**
 * The style guide, built from the real components: the foundations (colour
 * tokens, type, space, radius, elevation, icons), then each component group
 * with its states, in the active palette and light or dark.
 */
export function StyleGuidePage() {
  const { appearance, mode } = useAppearance()
  const palette = palettes.find((entry) => entry.id === appearance.theme) ?? palettes[0]
  const scheme = mode === "system" ? `${appearance.scheme}, following the device` : appearance.scheme
  return (
    <DottedPage className="text-foreground">
      <main className="mx-auto flex max-w-[1600px] flex-col gap-7 px-4 py-8 md:p-12">
        <header className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-4">
          <div className="flex flex-col gap-1.5">
            <h1 className="text-[28px] leading-tight font-bold tracking-[-0.01em] sm:text-[40px]">elaborat.ing style guide</h1>
            <p className="text-[15px] text-muted-foreground">
              {palette.label}, {scheme}. Every value is a token with a light and a dark value; components use tokens only.
            </p>
          </div>
          <div className="flex flex-col gap-3 sm:items-end">
            <p className="font-mono text-xs text-dim">Space Grotesk · JetBrains Mono · Excalifont · Lucide icons</p>
            <AppearancePicker />
          </div>
        </header>

        <ColourTokensSection />
        <div className="grid gap-7 lg:grid-cols-2">
          <TypeSection />
          <SpaceSection />
        </div>

        <GuideCard title="Components and states" className="gap-7">
          <ControlsSection />
          <NavigationSection />
        </GuideCard>
        <GuideCard title="C5 components" className="gap-7">
          <EditorChromeSection />
          <CanvasSection />
        </GuideCard>
      </main>
    </DottedPage>
  )
}
