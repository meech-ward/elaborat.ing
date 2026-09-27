import { GuideGroup } from "./parts"

// The Editor chrome group of the component library, shown on the style guide page.
// This section takes no props: it imports its components from ../ui and
// renders them with their states under its heading (GuideLabel captions each
// demo; see parts.tsx).
export function EditorChromeSection() {
  return <GuideGroup title="Editor chrome" />
}
