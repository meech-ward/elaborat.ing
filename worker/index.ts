/**
 * The Worker in front of the app's static files. It serves the MCP server at
 * this site's own address (`/mcp`) by passing those requests to the Supabase
 * Edge Function named in `MCP_UPSTREAM`, and rewrites the two places the
 * function names its address (the OAuth resource metadata and the 401
 * challenge) so MCP clients see this site's `/mcp` URL throughout, as RFC 9728
 * requires. Everything else is the app. Without `MCP_UPSTREAM` (a self-host
 * that doesn't set it) there is no `/mcp` and the Worker only serves the app.
 */

export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  MCP_UPSTREAM?: string;
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

export async function handle(request: Request, env: Env, fetcher: typeof fetch = fetch): Promise<Response> {
  const url = new URL(request.url);
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
