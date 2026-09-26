import { safeNextPath } from "@/lib/safe-next-path"

/**
 * Where an emailed sign-in link should land: the sign-in page on this site,
 * carrying the path to continue to afterwards (only a path on this site).
 */
export function emailLinkRedirect(origin: string, next: string | null | undefined): string {
  const url = new URL("/sign-in", origin)
  const target = safeNextPath(next, "/", origin)
  if (target !== "/") url.searchParams.set("next", target)
  return url.href
}
