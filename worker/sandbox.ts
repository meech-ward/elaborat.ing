/**
 * The Worker on the sandbox domain (wrangler.sandbox.jsonc): it serves the
 * note preview frame's page and nothing else (docs/architecture.md, Component
 * isolation). The page runs a note's code, so it lives on a registrable
 * domain of its own, away from the app's.
 *
 * Its files are this build's `frame/<hash>/` folder in dist-sandbox/
 * (vite-plugins/preview-frame.ts): the page, its script and its modules.
 * Every other path is not found. Every response carries the frame's policy:
 * scripts only from the page's own folder (plus eval, which MDX's `run()`
 * needs), no network, `data:` images and fonts, and framing only by the app
 * (`FRAME_ANCESTORS`). The files allow any origin, since the frame's own
 * origin is opaque (`sandbox="allow-scripts"`).
 */

export interface SandboxEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
  /** The app's origin, the only page that may frame the preview, such as https://elaborat.ing. Unset, nothing may. */
  FRAME_ANCESTORS?: string;
}

/** The frame's files: the page (its folder), its script and its modules. */
const FRAME_FILE = /^\/frame\/([0-9a-f]{16})\/(?:|frame\.js|charts\.js|highlighter\.js)$/;

/**
 * The frame's policy for a page in `folder` (an absolute URL ending in `/`).
 * The same as the `srcdoc` frame's (PREVIEW_CHILD_CSP in
 * src/features/rendered/protocol.ts), with scripts from the folder in place
 * of inline ones, and who may frame it.
 */
export function sandboxCsp(folder: string, frameAncestors: string): string {
  return (
    "default-src 'none'; " +
    `script-src ${folder} 'unsafe-eval'; ` +
    "style-src 'unsafe-inline'; " +
    "font-src data:; " +
    "img-src data:; " +
    "media-src 'none'; " +
    "connect-src 'none'; " +
    "form-action 'none'; " +
    "frame-src 'none'; " +
    "object-src 'none'; " +
    "base-uri 'none'; " +
    `frame-ancestors ${frameAncestors};`
  );
}

/** Origins only (scheme, host and port), separated by spaces; anything else leaves `'none'`. */
function ancestors(value: string | undefined): string {
  const origins = (value ?? "").split(/\s+/).filter(Boolean);
  if (origins.length === 0 || !origins.every((origin) => /^https?:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(origin))) return "'none'";
  return origins.join(" ");
}

export async function handleSandbox(request: Request, env: SandboxEnv): Promise<Response> {
  const url = new URL(request.url);
  const file = request.method === "GET" || request.method === "HEAD" ? FRAME_FILE.exec(url.pathname) : null;
  const folder = file ? `${url.origin}/frame/${file[1]}/` : `${url.origin}/frame/`;
  const headers = new Headers({
    "Content-Security-Policy": sandboxCsp(folder, ancestors(env.FRAME_ANCESTORS)),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  if (!file) {
    headers.set("Content-Type", "text/plain; charset=utf-8");
    return new Response("Not found", { status: 404, headers });
  }
  const response = await env.ASSETS.fetch(new Request(url, { method: request.method, headers: conditional(request) }));
  if (response.status !== 200 && response.status !== 304) {
    headers.set("Content-Type", "text/plain; charset=utf-8");
    return new Response("Not found", { status: 404, headers });
  }
  for (const name of ["Content-Type", "ETag", "Last-Modified"]) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  // The folder is named after its contents, so a file never changes.
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("Access-Control-Allow-Origin", "*");
  return new Response(response.body, { status: response.status, headers });
}

/** Only the request's revalidation headers reach the files: no cookies or credentials. */
function conditional(request: Request): Headers {
  const headers = new Headers();
  for (const name of ["If-None-Match", "If-Modified-Since"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

export default { fetch: (request: Request, env: SandboxEnv) => handleSandbox(request, env) };
