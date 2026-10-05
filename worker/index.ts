/**
 * The Worker in front of the app's static files. It serves the MCP server at
 * this site's own address (`/mcp`) by passing those requests to the Supabase
 * Edge Function named in `MCP_UPSTREAM`, and rewrites the two places the
 * function names its address (the OAuth resource metadata and the 401
 * challenge) so MCP clients see this site's `/mcp` URL throughout, as RFC 9728
 * requires. Everything else is the app. Without `MCP_UPSTREAM` (a self-host
 * that doesn't set it) there is no `/mcp` and the Worker only serves the app.
 *
 * `/.well-known/openai-apps-challenge` answers OpenAI's domain check for a
 * plugin listing with the token in `OPENAI_APPS_CHALLENGE`, as plain text;
 * without it set, that path is not found.
 *
 * `/embed` and its project pages are the app inside a chat's panel
 * (docs/architecture.md, Frontend hosting): framed only by the origins in
 * `EMBED_FRAME_ANCESTORS`, and by nothing while it is unset.
 *
 * Temporary host capability probe, remove after testing: `/mcp-probe` passes
 * to the probe function in `MCP_PROBE_UPSTREAM`.
 * Every other page, `/embed-probe` included, keeps `X-Frame-Options: DENY`
 * from public/_headers.
 */

import { frameAncestors } from "./frameAncestors.ts";

export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  MCP_UPSTREAM?: string;
  /** The token OpenAI gives to verify this domain for a plugin listing. */
  OPENAI_APPS_CHALLENGE?: string;
  /**
   * Who may frame `/embed`: exact origins separated by spaces, such as a chat
   * panel's view origin and the chat's own site. Unset, or with any entry that
   * is not an origin, nothing may.
   */
  EMBED_FRAME_ANCESTORS?: string;
  /** Temporary host capability probe, remove after testing. */
  MCP_PROBE_UPSTREAM?: string;
}

const PREFIX = "/mcp";
const METADATA = "/oauth-protected-resource";

/** The path under the upstream function for this request, or null when it is not for the MCP server. */
export function mcpPath(pathname: string): string | null {
  if (pathname === PREFIX || pathname.startsWith(`${PREFIX}/`)) return pathname.slice(PREFIX.length);
  // RFC 9728's well-known location for the resource at /mcp.
  if (pathname === `/.well-known/oauth-protected-resource${PREFIX}`) return METADATA;
  return null;
}

export const OPENAI_CHALLENGE_PATH = "/.well-known/openai-apps-challenge";

/** The domain check's answer: the token as plain text, or not found when none is set. */
function openAiChallenge(env: Env): Response {
  const token = env.OPENAI_APPS_CHALLENGE?.trim();
  if (!token) return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  return new Response(token, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

/** The app in a chat's panel: `/embed`, and a project or file under it. Other `/embed/` pages are never framed. */
export function embedPage(pathname: string): boolean {
  return pathname === "/embed" || pathname === "/embed/" || pathname.startsWith("/embed/projects/");
}

/** The page, with the framing policy in place of X-Frame-Options, kept out of search. */
async function framable(request: Request, env: Env, ancestors: string): Promise<Response> {
  const response = await env.ASSETS.fetch(request);
  const headers = new Headers(response.headers);
  headers.delete("X-Frame-Options");
  headers.set("Content-Security-Policy", `frame-ancestors ${ancestors}`);
  headers.set("X-Robots-Tag", "noindex");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

// Temporary host capability probe, remove after testing.
const PROBE_PREFIX = "/mcp-probe";

export async function handle(request: Request, env: Env, fetcher: typeof fetch = fetch): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === OPENAI_CHALLENGE_PATH) return openAiChallenge(env);
  const read = request.method === "GET" || request.method === "HEAD";
  if (read && embedPage(url.pathname)) return framable(request, env, frameAncestors(env.EMBED_FRAME_ANCESTORS));
  const probeUpstream = env.MCP_PROBE_UPSTREAM?.replace(/\/+$/, "");
  if (probeUpstream && (url.pathname === PROBE_PREFIX || url.pathname.startsWith(`${PROBE_PREFIX}/`))) {
    return fetcher(new Request(`${probeUpstream}${url.pathname.slice(PROBE_PREFIX.length)}${url.search}`, request));
  }
  const upstream = env.MCP_UPSTREAM?.replace(/\/+$/, "");
  const path = upstream ? mcpPath(url.pathname) : null;
  if (!upstream || path === null) return env.ASSETS.fetch(request);

  const publicUrl = `${url.origin}${PREFIX}`;
  const response = await fetcher(new Request(`${upstream}${path}${url.search}`, request));

  if (path === METADATA && request.method === "GET" && response.ok) {
    const metadata = (await response.json()) as Record<string, unknown>;
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    return new Response(JSON.stringify({ ...metadata, resource: publicUrl }), { status: response.status, headers });
  }

  const challenge = response.headers.get("WWW-Authenticate");
  if (challenge?.includes(upstream)) {
    const headers = new Headers(response.headers);
    headers.set("WWW-Authenticate", challenge.replaceAll(upstream, publicUrl));
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
  return response;
}

export default { fetch: (request: Request, env: Env) => handle(request, env) };
