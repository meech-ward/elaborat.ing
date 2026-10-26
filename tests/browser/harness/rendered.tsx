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
import type { DocumentEmbedHost } from '../../../src/features/rendered/documentEmbeds.ts'

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

// Exercise the real frame broker on the hosted sandbox origin as well as
// offline srcdoc. Workbench journeys cover durable sessions and undo.
const embeddedStores = new Map<string, ReturnType<typeof createDocumentStore>>()
type EmbeddedView = Parameters<DocumentEmbedHost['attach']>[0]
let embeddedViews: readonly EmbeddedView[] = []
const embeddedListeners = new Set<() => void>()
const publishEmbeds = () => { embeddedViews = [...embeddedViews]; for (const listener of embeddedListeners) listener() }
const embedHost: DocumentEmbedHost = {
  attach(request) {
    if (!embeddedStores.has(request.path)) {
      request.onState({error:`Missing document ${request.path}`, pending:false})
      return () => {}
    }
    embeddedViews = [...embeddedViews, request]
    publishEmbeds()
    request.onState({readOnly:false, pending:false})
    return () => { embeddedViews = embeddedViews.filter(view => view !== request); publishEmbeds() }
  },
  action() {},
}
const subscribeEmbeds = (listener: () => void) => { embeddedListeners.add(listener); return () => { embeddedListeners.delete(listener) } }
const embedSnapshot = () => embeddedViews

function EmbeddedEditors() {
  const views = useSyncExternalStore(subscribeEmbeds, embedSnapshot)
  return views.map(view => {
    const childStore = embeddedStores.get(view.path)!
    return <RenderedEditor key={view.id} document={childStore.snapshot()} documentId={childStore.snapshot().docId}
      documentPath={view.path} externalFrame={view.frame} externalFrameScriptUrl={view.frameScriptUrl}
      embeddedAncestors={view.ancestors} documentEmbedHost={embedHost}
      onContentHeight={height => view.onState({height})}
      onPatch={(revision, patches) => { childStore.applyPatches(revision,patches); publishEmbeds(); return true }}
      onError={error => { lastError = error; view.onState({error}) }} />
  })
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
        documentPath="root.mdx"
        documentEmbedHost={embedHost}
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
      <EmbeddedEditors />
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
  setEmbeddedDocuments: (documents: Record<string, string>) => {
    embeddedStores.clear()
    for (const [path,text] of Object.entries(documents)) embeddedStores.set(path,createDocumentStore(text,/\.mdx$/i.test(path) ? 'mdx' : 'md'))
  },
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
