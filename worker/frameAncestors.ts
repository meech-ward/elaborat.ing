/**
 * A `frame-ancestors` source list from a Worker variable, separated by spaces:
 * origins (scheme, host and port), or `https://*.` followed by a domain of at
 * least two labels, for a host that serves each app from its own subdomain.
 * Anything else, a bare wildcard, a path or an empty value, gives `'none'`, so
 * nothing may frame the page.
 */
const SOURCE = /^(?:https?:\/\/[a-z0-9.-]+(?::\d+)?|https:\/\/\*\.[a-z0-9-]+(?:\.[a-z0-9-]+)+)$/i;

export function frameAncestors(value: string | undefined): string {
  const sources = (value ?? "").split(/\s+/).filter(Boolean);
  if (sources.length === 0 || !sources.every((source) => SOURCE.test(source))) return "'none'";
  return sources.join(" ");
}
