import { describe, expect, test } from "bun:test";
import { handle, mcpPath, OPENAI_CHALLENGE_PATH } from "./index";
import { frameAncestors } from "./frameAncestors.ts";

const UPSTREAM = "https://ref.supabase.co/functions/v1/mcp-server";
const assets = { fetch: async () => new Response("app") };

describe("mcpPath", () => {
  test("maps /mcp and the well-known metadata, and nothing else", () => {
    expect(mcpPath("/mcp")).toBe("");
    expect(mcpPath("/mcp/oauth-protected-resource")).toBe("/oauth-protected-resource");
    expect(mcpPath("/.well-known/oauth-protected-resource/mcp")).toBe("/oauth-protected-resource");
    expect(mcpPath("/mcpx")).toBeNull();
    expect(mcpPath("/projects/1")).toBeNull();
  });
});

describe("handle", () => {
  test("serves the app for other paths, and when no upstream is set", async () => {
    expect(await (await handle(new Request("https://site.test/projects"), { ASSETS: assets, MCP_UPSTREAM: UPSTREAM })).text()).toBe("app");
    expect(await (await handle(new Request("https://site.test/mcp"), { ASSETS: assets })).text()).toBe("app");
  });

  test("passes MCP calls through with method, body and headers", async () => {
    let seen: Request | null = null;
    const response = await handle(
      new Request("https://site.test/mcp", { method: "POST", body: "{}", headers: { Authorization: "Bearer t" } }),
      { ASSETS: assets, MCP_UPSTREAM: UPSTREAM },
      (async (input: Request) => {
        seen = input;
        return new Response("ok");
      }) as unknown as typeof fetch,
    );
    expect(await response.text()).toBe("ok");
    expect(seen!.url).toBe(UPSTREAM);
    expect(seen!.method).toBe("POST");
    expect(seen!.headers.get("Authorization")).toBe("Bearer t");
    expect(await seen!.text()).toBe("{}");
  });

  test("names this site's /mcp in the resource metadata and the 401 challenge", async () => {
    const env = { ASSETS: assets, MCP_UPSTREAM: UPSTREAM };
    const metadata = await handle(new Request("https://site.test/.well-known/oauth-protected-resource/mcp"), env, (async () =>
      Response.json({ resource: UPSTREAM, authorization_servers: ["https://ref.supabase.co/auth/v1"] })) as unknown as typeof fetch,
    );
    expect(await metadata.json()).toEqual({ resource: "https://site.test/mcp", authorization_servers: ["https://ref.supabase.co/auth/v1"] });

    const challenge = await handle(new Request("https://site.test/mcp", { method: "POST" }), env, (async () =>
      new Response("", { status: 401, headers: { "WWW-Authenticate": `Bearer resource_metadata="${UPSTREAM}/oauth-protected-resource"` } })) as unknown as typeof fetch,
    );
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get("WWW-Authenticate")).toBe('Bearer resource_metadata="https://site.test/mcp/oauth-protected-resource"');
  });
});

describe("OpenAI's domain check", () => {
  const challenge = new Request(`https://site.test${OPENAI_CHALLENGE_PATH}`);

  test("answers with the token as plain text", async () => {
    const response = await handle(challenge, { ASSETS: assets, OPENAI_APPS_CHALLENGE: " token-123\n" });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(await response.text()).toBe("token-123");
  });

  test("is not found when no token is set, rather than the app", async () => {
    for (const env of [{ ASSETS: assets }, { ASSETS: assets, OPENAI_APPS_CHALLENGE: "" }]) {
      const response = await handle(challenge, env);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toBe("app");
    }
  });
});

describe("/embed, the app in a chat's panel", () => {
  const DENY = { "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff", "Content-Type": "text/html" };
  const framedAssets = { fetch: async (request: Request) => new Response(request.method === "HEAD" ? null : "<!doctype html>", { headers: DENY }) };
  const ORIGINS = "https://view-1.example.test https://chat.example.test";
  const framable = ["/embed", "/embed/", "/embed/projects/0b6a4a52-6f3e-4c1a-9d59-3b7f1c2a9e01", "/embed/projects/x/notes/a%20b.mdx?theme=dark"];

  test("its pages may be framed by exactly the configured origins, and are kept out of search", async () => {
    for (const path of framable) {
      for (const method of ["GET", "HEAD"]) {
        const response = await handle(new Request(`https://site.test${path}`, { method }), { ASSETS: framedAssets, EMBED_FRAME_ANCESTORS: ` ${ORIGINS}\n` });
        expect(response.headers.get("X-Frame-Options")).toBeNull();
        expect(response.headers.get("Content-Security-Policy")).toBe(`frame-ancestors ${ORIGINS}`);
        expect(response.headers.get("X-Robots-Tag")).toBe("noindex");
        expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      }
    }
  });

  test("unset, or with a wildcard, a path or anything else that is not an origin, nothing may frame them", async () => {
    for (const value of [undefined, "", "   ", "*", "https://*.example.test", "https://chat.example.test/", "https://chat.example.test/embed", "chat.example.test", "https://chat.example.test 'self'", `${ORIGINS} *`]) {
      const response = await handle(new Request("https://site.test/embed"), { ASSETS: framedAssets, EMBED_FRAME_ANCESTORS: value });
      expect(response.headers.get("Content-Security-Policy")).toBe("frame-ancestors 'none'");
      expect(response.headers.get("X-Frame-Options")).toBeNull();
    }
    expect(frameAncestors("https://a.test:8443 http://b.test")).toBe("https://a.test:8443 http://b.test");
  });

  test("every other page keeps X-Frame-Options DENY, including other /embed/ pages", async () => {
    const env = { ASSETS: framedAssets, EMBED_FRAME_ANCESTORS: ORIGINS };
    for (const path of ["/", "/projects/x", "/sign-in", "/embed/sign-in", "/embed/agents", "/embed/projectsx", "/embedded", "/style-guide"]) {
      const response = await handle(new Request(`https://site.test${path}`), env);
      expect(response.headers.get("X-Frame-Options")).toBe("DENY");
      expect(response.headers.get("Content-Security-Policy")).toBeNull();
    }
  });

  test("requests that only read are given the policy; others pass through to the files", async () => {
    for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
      const response = await handle(new Request("https://site.test/embed", { method }), { ASSETS: framedAssets, EMBED_FRAME_ANCESTORS: ORIGINS });
      expect(response.headers.get("X-Frame-Options")).toBe("DENY");
      expect(response.headers.get("Content-Security-Policy")).toBeNull();
    }
  });
});

// Temporary host capability probe, remove after testing.
describe("the probe routes", () => {
  const DENY = { "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff" };
  const framedAssets = { fetch: async () => new Response("<!doctype html>", { headers: DENY }) };
  const env = { ASSETS: framedAssets, MCP_UPSTREAM: UPSTREAM, MCP_PROBE_UPSTREAM: "https://ref.supabase.co/functions/v1/mcp-probe" };

  test("/embed-probe may not be framed, like every other page", async () => {
    for (const path of ["/embed-probe", "/embed-probe/", "/embed-probe?from=widget", "/embed-probe/child"]) {
      const response = await handle(new Request(`https://site.test${path}`), env);
      expect(response.headers.get("X-Frame-Options")).toBe("DENY");
      expect(response.headers.get("Content-Security-Policy")).toBeNull();
    }
  });

  test("every other path is served straight from the static files, which send X-Frame-Options DENY", async () => {
    const headers = await Bun.file(new URL("../public/_headers", import.meta.url)).text();
    const all = headers.split(/\n(?=\/)/).find((block) => block.startsWith("/*\n"));
    expect(all).toContain("X-Frame-Options: DENY");
    expect(headers).not.toMatch(/!\s*X-Frame-Options|frame-ancestors/i);
    const wrangler = await Bun.file(new URL("../wrangler.jsonc", import.meta.url)).text();
    const first = JSON.parse(wrangler.match(/"run_worker_first":\s*(\[[^\]]*\])/)![1]) as string[];
    expect(first).toEqual(["/mcp", "/mcp/*", "/.well-known/oauth-protected-resource/mcp", "/.well-known/openai-apps-challenge", "/embed", "/embed/*", "/mcp-probe", "/mcp-probe/*"]);
  });

  test("/mcp-probe passes to the probe function, and /mcp still to the MCP server", async () => {
    const seen: string[] = [];
    const fetcher = (async (input: Request) => {
      seen.push(input.url);
      return new Response("ok");
    }) as unknown as typeof fetch;
    await handle(new Request("https://site.test/mcp-probe", { method: "POST", body: "{}" }), env, fetcher);
    await handle(new Request("https://site.test/mcp", { method: "POST", body: "{}" }), env, fetcher);
    expect(seen).toEqual(["https://ref.supabase.co/functions/v1/mcp-probe", UPSTREAM]);
    expect(mcpPath("/mcp-probe")).toBeNull();
  });
});
