/**
 * A `frame-ancestors` source list from a Worker variable: origins only
 * (scheme, host and port), separated by spaces. Anything else, a wildcard, a
 * path or an empty value, gives `'none'`, so nothing may frame the page.
 */
export function frameAncestors(value: string | undefined): string {
  const origins = (value ?? "").split(/\s+/).filter(Boolean);
  if (origins.length === 0 || !origins.every((origin) => /^https?:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(origin))) return "'none'";
  return origins.join(" ");
}
