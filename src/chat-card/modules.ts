/**
 * The chat card's code that only some cards need, loaded when it is needed:
 * the note editor (on Edit), the live view (for a new file shown while it is
 * written), the code highlighter (for a note with a code block), the
 * component compiler (for a note with
 * components, or a component file) and the component preview frame's
 * runtime, which the frame loads itself and which loads the charts' library
 * only for a note with a chart. `bun run build:chat-card` builds them as ES
 * modules into public/chat-card, which the app's deploy serves at
 * https://elaborat.ing/chat-card/ with CORS (public/_headers), and sets their
 * addresses here.
 *
 * The view declares that origin in its CSP (`_meta.ui.csp.resourceDomains`,
 * fileView.ts). A host that does not allow it blocks the import, or says so
 * up front in `hostCapabilities.sandbox.csp`; the card then stays read-only
 * with the server's HTML, as it is without them.
 */
import type * as Compile from "./lazy/compile"
import type * as Editor from "./lazy/editor"
import type * as Highlight from "./lazy/highlight"
import type * as Live from "./lazy/live"

/** The modules' addresses, which scripts/build-chat-card.ts sets. */
declare const CARD_MODULES: { editor: string; live: string; compile: string; highlight: string; frame: string; frameStyle: string }

type Modules = { editor: typeof Editor; live: typeof Live; compile: typeof Compile; highlight: typeof Highlight }

let known: typeof CARD_MODULES | undefined
/** The addresses, read once: the build writes them where CARD_MODULES is named. */
const addresses = () => (known ??= CARD_MODULES)

/** The card could not load a module: the host blocks its origin, or it could not be reached. */
export class ModuleNotLoaded extends Error {}

const loading = new Map<keyof Modules, Promise<unknown>>()
let blocked = false

/** Stops the card from trying: the host said it does not allow the modules' origin. */
export function blockModules() {
  blocked = true
}

/** Loads a module once. One that did not load stays failed: the browser keeps the failure for the page. */
export function loadModule<K extends keyof Modules>(name: K): Promise<Modules[K]> {
  if (blocked) return Promise.reject(new ModuleNotLoaded(name))
  let started = loading.get(name)
  if (!started) {
    started = import(/* @vite-ignore */ addresses()[name]).catch(() => {
      throw new ModuleNotLoaded(name)
    })
    loading.set(name, started)
  }
  return started as Promise<Modules[K]>
}

/** The preview frame's runtime and stylesheet, which the frame's document loads. */
export const frameModules = () => ({ runtime: addresses().frame, style: addresses().frameStyle })

/**
 * Whether the host allows the modules, from the origins it says it approved
 * for resources (`hostCapabilities.sandbox.csp.resourceDomains`): null when
 * it did not say.
 */
export function modulesAllowed(resourceDomains: readonly string[] | null): boolean | null {
  if (resourceDomains === null) return null
  const origin = new URL(addresses().frame).origin
  return resourceDomains.some((domain) => {
    try {
      return new URL(domain).origin === origin
    } catch {
      return false
    }
  })
}
