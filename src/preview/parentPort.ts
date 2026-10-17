/**
 * The frame's line to the app (docs/architecture.md, Component isolation).
 * The frame says `ready` with a window post, and the app answers, once, with
 * a MessagePort. From then on every message both ways goes over that port,
 * which stays with this document: a page the frame navigates to can never
 * receive or send on it. A clicked link is the one exception (postLinkToParent).
 */
import { checkConnectMessage } from "../features/rendered/protocol";

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
  if (port) window.parent.postMessage(message, "*");
}

/** Say ready, take the app's port when it answers, and hear the app on it with `onMessage`. */
export function connectToParent(onMessage: (event: MessageEvent) => void): void {
  const onConnect = (event: MessageEvent) => {
    const accepted = checkConnectMessage({
      data: event.data,
      source: event.source,
      parent: window.parent,
      ports: event.ports,
      connected: port !== null,
    });
    if (!accepted) return;
    window.removeEventListener("message", onConnect);
    port = accepted;
    port.onmessage = onMessage;
  };
  window.addEventListener("message", onConnect);
  window.parent.postMessage({ kind: "ready", session: "pending" }, "*");
}
