// A test-only page: the real rendered editor over an in-memory document, the
// way the workbench will mount it, but with no storage. `window.renderedHarness`
// loads a note, reads back its source, delivers diagram pixels and sets the
// appearance; edits go through the frame's own UI.
import "../../../src/index.css"
import { StrictMode, useEffect, useState, useSyncExternalStore } from "react"
import { createRoot } from "react-dom/client"
import { AppearanceProvider, useAppearance } from "../../../src/features/appearance/index.ts"
import type { ColorScheme, ThemeName } from "../../../src/features/appearance/tokens.ts"
import type { DocumentSnapshot } from "../../../src/features/document/index.ts"
import { RenderedEditor } from "../../../src/features/rendered/index.ts"
import { createDocumentStore } from "../../../src/lib/documentStore.ts"

// `?sandbox=<origin>` loads the frame's page from that origin (tests/browser/sandbox-server.ts).
const sandboxOrigin = new URLSearchParams(location.search).get("sandbox")
const store = createDocumentStore("", "md")
let state = { snapshot: store.snapshot(), resources: undefined as Record<string, string> | undefined }
let pending = false
let lastError: string | null = null
let appearance: { setTheme: (theme: ThemeName) => void; setScheme: (scheme: ColorScheme) => void } | null = null
const listeners = new Set<() => void>()
const publish = (next: Partial<typeof state>) => {
  state = { ...state, ...next }
  for (const listener of listeners) listener()
}
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function AppearanceBridge() {
  const { setTheme, setScheme } = useAppearance()
  useEffect(() => {
    appearance = { setTheme, setScheme }
  }, [setTheme, setScheme])
  return null
}

function App() {
  const { snapshot, resources } = useSyncExternalStore(subscribe, () => state)
  const [, setError] = useState<string | null>(null)
  return (
    <main style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <h1 className="sr-only">Rendered note</h1>
      <AppearanceBridge />
      <RenderedEditor
        key={snapshot.docId}
        document={snapshot}
        documentId={snapshot.docId}
        resources={resources}
        sandboxOrigin={sandboxOrigin}
        onPatch={(revision, patches) => {
          try {
            publish({ snapshot: store.applyPatches(revision, patches) })
            return true
          } catch {
            return false
          }
        }}
        onPendingChange={(next) => {
          pending = next
        }}
        onError={(message) => {
          lastError = message
          setError(message)
        }}
      />
    </main>
  )
}

const harness = {
  load: (text: string, format: DocumentSnapshot["format"]) => publish({ snapshot: store.replaceDocument(text, format), resources: undefined }),
  /** The person's edit in the Source view: the same note, so the same editor and frame. */
  edit: (text: string) => publish({ snapshot: store.setText(text) }),
  source: () => state.snapshot.text,
  state: () => ({ revision: state.snapshot.revision, pending, error: lastError }),
  setResources: (resources: Record<string, string>) => publish({ resources }),
  appearance: (theme: ThemeName, scheme: ColorScheme) => {
    appearance?.setTheme(theme)
    appearance?.setScheme(scheme)
  },
}

declare global {
  interface Window {
    renderedHarness: typeof harness
  }
}
window.renderedHarness = harness

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppearanceProvider>
      <App />
    </AppearanceProvider>
  </StrictMode>,
)
