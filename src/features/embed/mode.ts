/**
 * The app inside a chat's panel (docs/architecture.md, Frontend hosting): a
 * page opened at /embed or under it. Decided once, when the app starts. The
 * router then works under /embed (its basepath), so every route, link and
 * project URL stays as it is, and the rest of the embed code (its chrome,
 * sign-in and messages to the panel) loads in a chunk of its own.
 */

export const EMBED_BASE = "/embed"

/** /embed and the paths under it, never /embed-probe. */
export function isEmbedPath(pathname: string): boolean {
  return pathname === EMBED_BASE || pathname.startsWith(`${EMBED_BASE}/`)
}

/** The same page on the site, outside the panel: /embed/projects/x is /projects/x. */
export function sitePath(pathname: string): string {
  return isEmbedPath(pathname) ? pathname.slice(EMBED_BASE.length) || "/" : pathname
}

/** True when this page is the app in a panel. */
export const embedded: boolean = typeof window !== "undefined" && isEmbedPath(window.location.pathname)

/** True when another page frames this one. */
export function framed(): boolean {
  try {
    return window.self !== window.top
  } catch {
    return true
  }
}

/** The light or dark the panel asked for in `?theme=`, or null for the device's. */
export function requestedScheme(search: string): "light" | "dark" | null {
  const theme = new URLSearchParams(search).get("theme")
  return theme === "light" || theme === "dark" ? theme : null
}
