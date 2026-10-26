/**
 * The frame's line to the app (docs/architecture.md, Component isolation).
 * The frame says `ready` with a window post, and the app answers, once, with
 * a MessagePort. From then on every message both ways goes over that port,
 * which stays with this document: a page the frame navigates to can never
 * receive or send on it. Clicked links and Copy code use window posts to
 * preserve WebKit's user activation.
 */
import { checkConnectMessage } from "../features/rendered/protocol";
import { MAX_DOCUMENT_EMBED_DEPTH } from '../features/rendered/documentEmbeds';

const bootstrap = typeof document === 'undefined' ? undefined : document.documentElement.dataset;
const config = {ancestor:Number(bootstrap?.documentFrameAncestor),nonce:bootstrap?.documentFrameNonce ?? ''};
if (bootstrap) {
  delete bootstrap.documentFrameAncestor;
  delete bootstrap.documentFrameNonce;
}
export const embeddedDocument = Number.isInteger(config.ancestor) && config.ancestor >= 2 && config.ancestor <= MAX_DOCUMENT_EMBED_DEPTH && /^[a-f\d]{32}$/.test(config.nonce);
let appParent = typeof window === 'undefined' ? null : window.parent;
if (embeddedDocument && appParent) for (let depth = 1; depth < config.ancestor; depth++) appParent = appParent.parent;

let port: MessagePort | null = null;

/** Send the app a message. Nothing goes before the app has answered `ready`. */
export function postToParent(message: unknown): void {
  port?.postMessage(message);
}

/**
 * Send the app a link the person clicked, as a window post. WebKit runs the
 * app's handler for a window post as part of the click, and for a port message
 * it does not, so Safari would block the tab the app opens. The app takes it
 * only from this frame's window, with the session it sent this document on the
 * port. Nothing goes before the app has answered `ready`.
 */
export function postLinkToParent(message: unknown): void {
  if (port) appParent?.postMessage(message, "*");
}

/** Copy uses the same activation-preserving path; the result uses the port. */
export function postCodeCopyToParent(message: unknown): boolean {
  if (!port) return false;
  appParent?.postMessage(message, '*');
  return true;
}

/** Say ready, take the app's port when it answers, and hear the app on it with `onMessage`. */
export function connectToParent(onMessage: (event: MessageEvent) => void): void {
  if (!appParent || typeof window === 'undefined') return;
  const onConnect = (event: MessageEvent) => {
    const accepted = checkConnectMessage({
      data: event.data,
      source: event.source,
      parent: appParent,
      ports: event.ports,
      connected: port !== null,
    });
    if (!accepted) return;
    window.removeEventListener("message", onConnect);
    port = accepted;
    port.onmessage = onMessage;
  };
  window.addEventListener("message", onConnect);
  appParent.postMessage(embeddedDocument ? { kind: 'document-embed-ready', nonce: config.nonce } : { kind: "ready", session: "pending" }, "*");
}
