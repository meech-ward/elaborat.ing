import { describe, expect, test } from "bun:test";
import { PREVIEW_CHILD_CSP } from "../src/features/rendered/protocol";
import { handleSandbox, sandboxCsp } from "./sandbox";

const HOST = "https://usercontent.test";
const FOLDER = "/frame/0123456789abcdef/";
const files: Record<string, { body: string; type: string }> = {
  [FOLDER]: { body: "<!doctype html><title>frame</title>", type: "text/html; charset=utf-8" },
  [`${FOLDER}frame.js`]: { body: "frame()", type: "application/javascript" },
  [`${FOLDER}charts.js`]: { body: "charts()", type: "application/javascript" },
  [`${FOLDER}highlighter.js`]: { body: "highlighter()", type: "application/javascript" },
  // In the assets, but not one of the frame's files.
  "/": { body: "app", type: "text/html" },
  [`${FOLDER}index.html`]: { body: "page", type: "text/html" },
};

function sandbox() {
  const asked: Request[] = [];
  const assets = {
    fetch: async (request: Request) => {
      asked.push(request);
      const file = files[new URL(request.url).pathname];
      if (!file) return new Response("missing", { status: 404 });
      if (request.headers.get("If-None-Match") === '"v1"') return new Response(null, { status: 304, headers: { ETag: '"v1"' } });
      return new Response(file.body, { headers: { "Content-Type": file.type, ETag: '"v1"', "Set-Cookie": "session=1" } });
    },
  };
  const get = (path: string, init?: RequestInit, env: { FRAME_ANCESTORS?: string } = { FRAME_ANCESTORS: "https://app.test" }) =>
    handleSandbox(new Request(`${HOST}${path}`, init), { ASSETS: assets, ...env });
  return { asked, get };
}

/** The CSP's directives, by name. */
const directives = (csp: string | null): Record<string, string> =>
  Object.fromEntries((csp ?? "").split(";").map((part) => part.trim()).filter(Boolean).map((part) => [part.split(" ")[0], part.split(" ").slice(1).join(" ")]));

describe("the sandbox domain", () => {
  test("serves the frame's page with its policy: scripts from its own folder, no network, framed by the app only", async () => {
    const { get } = sandbox();
    const response = await get(FOLDER);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<!doctype html><title>frame</title>");
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    const csp = directives(response.headers.get("Content-Security-Policy"));
    expect(csp["script-src"]).toBe(`${HOST}${FOLDER} 'unsafe-eval'`);
    expect(csp["default-src"]).toBe("'none'");
    expect(csp["connect-src"]).toBe("'none'");
    expect(csp["img-src"]).toBe("data:");
    expect(csp["frame-ancestors"]).toBe("https://app.test");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
  });

  test("the policy is the srcdoc frame's, with the folder's scripts in place of inline ones, and who may frame it", () => {
    const srcdoc = directives(PREVIEW_CHILD_CSP);
    const hosted = directives(sandboxCsp(`${HOST}${FOLDER}`, "https://app.test"));
    const rest = (csp: Record<string, string>) => Object.entries(csp).filter(([name]) => name !== "script-src" && name !== "frame-ancestors");
    expect(rest(hosted)).toEqual(rest(srcdoc));
    expect(srcdoc["script-src"]).toBe("'unsafe-inline' 'unsafe-eval'");
    expect(hosted["script-src"]).toBe(`${HOST}${FOLDER} 'unsafe-eval'`);
  });

  test("serves the page's script and modules to the opaque-origin frame, with CORS and no cookies", async () => {
    const { get } = sandbox();
    for (const name of ["frame.js", "charts.js", "highlighter.js"]) {
      const response = await get(`${FOLDER}${name}`, { headers: { Origin: "null", Cookie: "session=1" } });
      expect(response.status).toBe(200);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(response.headers.get("Content-Type")).toBe("application/javascript");
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(response.headers.get("Set-Cookie")).toBeNull();
    }
  });

  test("passes revalidation through, and nothing else of the request", async () => {
    const { asked, get } = sandbox();
    const response = await get(`${FOLDER}frame.js`, { headers: { "If-None-Match": '"v1"', Cookie: "session=1", Authorization: "Bearer t" } });
    expect(response.status).toBe(304);
    expect(response.headers.get("ETag")).toBe('"v1"');
    expect([...asked[0].headers.keys()]).toEqual(["if-none-match"]);
  });

  test("every other path is not found, without asking the assets", async () => {
    const { asked, get } = sandbox();
    for (const path of ["/", "/index.html", "/sw.js", "/assets/app-1234.js", "/chat-card/frame.js", `${FOLDER}index.html`, `${FOLDER}other.js`, "/frame/0123456789abcdef", "/frame/0123456789ABCDEF/", "/frame/xyz/", `${FOLDER}../frame.js`, "/mcp"]) {
      const response = await get(path);
      expect(response.status, path).toBe(404);
      expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(directives(response.headers.get("Content-Security-Policy"))["connect-src"]).toBe("'none'");
    }
    expect(asked.filter((request) => new URL(request.url).pathname !== FOLDER)).toEqual([]);
    expect((await get(FOLDER, { method: "POST", body: "x" })).status).toBe(404);
  });

  test("a version this deploy does not have is not found", async () => {
    const { get } = sandbox();
    expect((await get("/frame/fedcba9876543210/")).status).toBe(404);
  });

  test("without a valid app origin, no page may frame it", async () => {
    const { get } = sandbox();
    for (const value of [undefined, "", "*", "https://app.test/path", "https://app.test 'self'"]) {
      const response = await get(FOLDER, undefined, { FRAME_ANCESTORS: value });
      expect(directives(response.headers.get("Content-Security-Policy"))["frame-ancestors"]).toBe("'none'");
    }
  });
});
