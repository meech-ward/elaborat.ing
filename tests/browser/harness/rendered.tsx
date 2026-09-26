// A test-only page: the real rendered editor over an in-memory document, the
// way the workbench will mount it, but with no storage. `window.harness`
// loads a note and reads back its source; edits go through the frame's UI.
import "../../../src/index.css"
import { StrictMode, useState, useSyncExternalStore } from "react"
import { createRoot } from "react-dom/client"
import { AppearanceProvider } from "../../../src/features/appearance/index.ts"
import { RenderedEditor } from "../../../src/features/rendered/index.ts"
import type { DocumentSnapshot } from "../../../src/features/document/index.ts"
import { createDocumentStore } from "../../../src/lib/documentStore.ts"

const store = createDocumentStore("", "md")
let snapshot = store.snapshot()
let pending = false
let lastError: string | null = null
const listeners = new Set<() => void>()
const publish = (next: typeof snapshot) => {
  snapshot = next
  for (const listener of listeners) listener()
}

function App() {
  const current = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => snapshot,
  )
  const [, setError] = useState<string | null>(null)
  return (
    <main style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <h1 className="sr-only">Rendered note</h1>
      <RenderedEditor
        key={current.docId}
        document={current}
        documentId={current.docId}
        onPatch={(revision, patches) => {
          try {
            publish(store.applyPatches(revision, patches))
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
  load: (text: string, format: DocumentSnapshot["format"]) => publish(store.replaceDocument(text, format)),
  source: () => snapshot.text,
  state: () => ({ revision: snapshot.revision, pending, error: lastError }),
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
