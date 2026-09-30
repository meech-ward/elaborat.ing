import { useRef } from "react"
import { DottedPage } from "@/components/panel"
import { palettes, useAppearance } from "@/features/appearance"
import { moduleLoader, useModule } from "@/lib/moduleLoader"
import { Banner, BannerAction } from "../ui/Banner"
import { LoadingLine } from "../ui/LoadingLine"
import { AppearancePicker } from "./AppearancePicker"
import { ColourTokensSection } from "./ColourTokensSection"
import { GuideCard, GuidePortal } from "./parts"
import { SpaceSection } from "./SpaceSection"
import { TypeSection } from "./TypeSection"

// The components, from the approved sheet down, load after the foundations
// have drawn: they are most of the page's code.
const librarySections = moduleLoader(() => import("./LibrarySections"))

/**
 * The style guide, built from the real components. The top of the page is
 * the sheet as it was approved: the foundations (colour tokens, type, space,
 * radius, elevation, icons) and the components and states card. Below it,
 * the rest of the library: every component group with its states, and the
 * C5 screens' pieces, in the active palette and light or dark.
 */
export function StyleGuidePage() {
  const { appearance } = useAppearance()
  const palette = palettes.find((entry) => entry.id === appearance.theme) ?? palettes[0]
  // Live popups render here, inside the main landmark (see GuidePortal).
  const portal = useRef<HTMLDivElement>(null)
  return (
    <GuidePortal value={portal}>
      <DottedPage className="text-foreground">
        <main className="mx-auto max-w-[1600px] px-4 py-8 md:p-12">
          <div className="flex flex-col gap-7">
            {/* The title and subtitle as the sheet has them; the fonts line
                and the palette and mode controls share the right side, so
                the cards start where the sheet's do. */}
            <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
              <div className="flex flex-col gap-1.5">
                <h1 className="text-[28px] leading-[normal] font-bold tracking-[-0.01em] sm:text-[40px]">elaborat.ing style guide</h1>
                <p className="text-[15px] leading-[normal] text-muted-foreground">
                  {palette.label}, {appearance.scheme}. Every value is a token with a light and a dark value; components use tokens only.
                </p>
              </div>
              <div className="flex flex-col gap-1 sm:items-end">
                <p className="font-mono text-xs leading-[normal] text-dim">Space Grotesk · JetBrains Mono · Excalifont · Lucide icons</p>
                <AppearancePicker />
              </div>
            </header>

            <ColourTokensSection />
            <div className="grid gap-7 lg:grid-cols-2">
              <TypeSection />
              <SpaceSection />
            </div>
            <Library />
          </div>
          <div ref={portal} />
        </main>
      </DottedPage>
    </GuidePortal>
  )
}

/** The component sections once their chunk has loaded: a card with a loading line until then, and Try again when it fails. */
function Library() {
  const { module, error, retry } = useModule(librarySections, true)
  if (module) {
    const { LibrarySections } = module
    return <LibrarySections />
  }
  return (
    <GuideCard title="Components and states">
      {error ? (
        <Banner tone="danger" action={<BannerAction onClick={retry}>Try again</BannerAction>}>
          The components could not load.
        </Banner>
      ) : (
        <LoadingLine label="Loading the components" />
      )}
    </GuideCard>
  )
}
