import { describe, expect, test } from "bun:test";
import { handle, mcpPath } from "./index";

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
