import { AgentChangesSection } from "./AgentChangesSection"
import { CanvasSection } from "./CanvasSection"
import { ChatCardSection } from "./ChatCardSection"
import { CommentsSection } from "./CommentsSection"
import { ComponentsSheet } from "./ComponentsSheet"
import { ControlsSection } from "./ControlsSection"
import { EditorChromeSection } from "./EditorChromeSection"
import { HomeSection } from "./HomeSection"
import { NavigationSection } from "./NavigationSection"
import { GuideCard, GuideValue } from "./parts"

/**
 * The style guide from the approved sheet's components card down
 * (StyleGuidePage.tsx), in a chunk of its own.
 */
export function LibrarySections() {
  return (
    <>
      <ComponentsSheet />

      {/* On phones the phone samples span the screen, past the card's padding (c5Samples.tsx). */}
      <GuideCard title="More components and states" className="gap-7 max-sm:overflow-visible">
        <GuideValue className="-mt-3.5">
          The rest of the library, for review: more states, and the components the sheet above leaves out.
        </GuideValue>
        <ControlsSection />
        <NavigationSection />
      </GuideCard>
      <GuideCard title="C5 components" className="gap-7 max-sm:overflow-visible">
        <EditorChromeSection />
        <CanvasSection />
      </GuideCard>
      <GuideCard title="Comments" className="gap-7 max-sm:overflow-visible">
        <CommentsSection />
      </GuideCard>
      <GuideCard title="Agent changes" className="gap-7">
        <AgentChangesSection />
      </GuideCard>
      <GuideCard title="Pages outside a project" className="gap-7">
        <HomeSection />
      </GuideCard>
      <GuideCard title="Chat card" className="gap-7">
        <ChatCardSection />
      </GuideCard>
    </>
  )
}
