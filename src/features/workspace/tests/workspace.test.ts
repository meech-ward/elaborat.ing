import { describe, expect, test } from "bun:test";
import {
  isAllowedWorkspacePath,
  validateWorkspacePath,
  WORKSPACE_MAX_CONTENT_BYTES,
} from "../index.ts";
import { summarizeDrawing } from "../summary.ts";

describe("validateWorkspacePath", () => {
  test("accepts nested allowed files", () => {
    expect(validateWorkspacePath("notes/plan.md")).toBe("notes/plan.md");
    expect(validateWorkspacePath("a/b/c.d2")).toBe("a/b/c.d2");
    expect(validateWorkspacePath("scene.excalidraw")).toBe("scene.excalidraw");
    expect(validateWorkspacePath("scene.excalidraw.md")).toBe("scene.excalidraw.md");
    expect(validateWorkspacePath("doc.mdx")).toBe("doc.mdx");
    expect(validateWorkspacePath("sidecar.json")).toBe("sidecar.json");
  });

  test("rejects traversal, absolute and encoded attacks", () => {
    expect(validateWorkspacePath("../outside.md")).toBeNull();
    expect(validateWorkspacePath("a/../../b.md")).toBeNull();
    expect(validateWorkspacePath("/etc/passwd.md")).toBeNull();
    expect(validateWorkspacePath("C:/x.md")).toBeNull();
    expect(validateWorkspacePath("a\\b.md")).toBeNull();
    expect(validateWorkspacePath("%2e%2e/secret.md")).toBeNull();
    expect(validateWorkspacePath("%252e%252e/secret.md")).toBeNull();
    expect(validateWorkspacePath("a/%2e%2e/b.md")).toBeNull();
    // Single-encoded "/" is just a separator: decodes to the benign "a/b.md".
    expect(validateWorkspacePath("a%2fb.md")).toBe("a/b.md");
    // ...while an encoded leading slash stays an absolute-path rejection.
    expect(validateWorkspacePath("%2fetc.md")).toBeNull();
  });

  test("rejects dotfiles, empty segments and unsupported extensions", () => {
    expect(validateWorkspacePath(".env")).toBeNull();
    expect(validateWorkspacePath("a/.hidden.md")).toBeNull();
    expect(validateWorkspacePath("a//b.md")).toBeNull();
    expect(validateWorkspacePath("a/./b.md")).toBeNull();
    expect(validateWorkspacePath("run.html")).toBeNull();
    expect(validateWorkspacePath("app.js")).toBeNull();
    expect(validateWorkspacePath("noext")).toBeNull();
    expect(validateWorkspacePath("")).toBeNull();
  });

  test("content limit and extension allowlist", () => {
    expect(WORKSPACE_MAX_CONTENT_BYTES).toBe(2 * 1024 * 1024);
    expect(isAllowedWorkspacePath("ok.md")).toBe(true);
    expect(isAllowedWorkspacePath("nope.exe")).toBe(false);
  });
});

describe("summarizeDrawing", () => {
  test("excalidraw scene counts elements and text, preserves unknown fields", () => {
    const content = JSON.stringify({
      type: "excalidraw",
      version: 2,
      appState: { viewBackgroundColor: "#fff" },
      customFutureField: { nested: [1, 2, 3] },
      elements: [
        { id: "a", type: "rectangle", x: 1 },
        { id: "b", type: "text", text: "hello", fontSize: 20 },
        { id: "c", type: "text", text: "", fontSize: 20 },
        { id: "d", type: "freedraw", points: [[0, 0]] },
      ],
    });
    const summary = summarizeDrawing("board/scene.excalidraw", content, "rev1");
    expect(summary.kind).toBe("excalidraw");
    expect(summary.parseOk).toBe(true);
    expect(summary.totalElements).toBe(4);
    expect(summary.textCount).toBe(1);
    expect(summary.elementsByType).toEqual({ rectangle: 1, text: 2, freedraw: 1 });
  });

  test("malformed json reports parseOk false without throwing", () => {
    const summary = summarizeDrawing("x.excalidraw", "{not json", "r");
    expect(summary.parseOk).toBe(false);
    expect(summary.totalElements).toBe(0);
  });

  test("plain json sidecar is valid but not a scene", () => {
    const summary = summarizeDrawing("meta.json", JSON.stringify({ a: 1 }), "r");
    expect(summary.kind).toBe("json");
    expect(summary.parseOk).toBe(true);
  });

  test("d2 and markdown summaries are heuristic counts", () => {
    const d2 = summarizeDrawing("arch.d2", "# c\nweb -> db\ndb: Postgres\n", "r");
    expect(d2.kind).toBe("d2");
    expect(d2.elementsByType.connections).toBe(1);
    const md = summarizeDrawing("n.md", "# T\n\n```d2\nx -> y\n```\n", "r");
    expect(md.kind).toBe("markdown");
    expect(md.elementsByType.headings).toBe(1);
    expect(md.elementsByType.codeFences).toBe(1);
  });
});
