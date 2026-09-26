import { describe, expect, test } from "bun:test";
import {
  copyPayloadForPath,
  renameNameError,
  renameStemLength,
} from "./explorerActions";

describe("copyPayloadForPath", () => {
  test("filename is the basename, path is the full workspace-relative form", () => {
    expect(copyPayloadForPath("notes/plan.md")).toEqual({
      filename: "plan.md",
      fullPath: "notes/plan.md",
    });
    expect(copyPayloadForPath("top.mdx")).toEqual({
      filename: "top.mdx",
      fullPath: "top.mdx",
    });
    expect(copyPayloadForPath("a/b/scene.excalidraw.md")).toEqual({
      filename: "scene.excalidraw.md",
      fullPath: "a/b/scene.excalidraw.md",
    });
  });
});

describe("renameNameError", () => {
  test("accepts a valid same-folder, same-extension name", () => {
    expect(renameNameError("notes/plan.md", "next.md")).toBeNull();
    expect(renameNameError("top.mdx", "renamed.mdx")).toBeNull();
    expect(renameNameError("a/b/flow.d2", "schema.d2")).toBeNull();
  });

  test("refuses the unchanged name without a server round trip", () => {
    expect(renameNameError("notes/plan.md", "plan.md")).toMatch(/current name/);
  });

  test("refuses separators, leading dots, and dot segments", () => {
    expect(renameNameError("notes/plan.md", "sub/plan.md")).toMatch(/one file name/);
    expect(renameNameError("notes/plan.md", "..")).toMatch(/one file name/);
    expect(renameNameError("notes/plan.md", ".hidden.md")).toMatch(/one file name/);
    expect(renameNameError("notes/plan.md", "a\\b.md")).toMatch(/one file name/);
    expect(renameNameError("notes/plan.md", "")).toMatch(/one file name/);
  });

  test("requires the same extension, including compound suffixes", () => {
    expect(renameNameError("notes/plan.md", "plan.mdx")).toMatch(/same extension/);
    expect(renameNameError("flow.d2", "flow.md")).toMatch(/same extension/);
    expect(renameNameError("s.excalidraw.md", "s.md")).toMatch(/same extension/);
    expect(renameNameError("s.excalidraw.md", "t.excalidraw.md")).toBeNull();
    expect(renameNameError("f.d2.json", "g.d2.json")).toBeNull();
    expect(renameNameError("f.d2.json", "g.json")).toMatch(/same extension/);
    expect(renameNameError("notes/plan.md", "plan")).toMatch(/allowed extension/);
  });

  test("refuses %-sequences that would address a different file", () => {
    expect(renameNameError("notes/plan.md", "a%2fmd")).toMatch(/allowed extension/);
    expect(renameNameError("notes/plan.md", "100%.md")).toMatch(/allowed extension/);
  });
});

describe("renameStemLength", () => {
  test("covers the basename minus its extension", () => {
    expect(renameStemLength("notes/plan.md")).toBe("plan".length);
    expect(renameStemLength("s.excalidraw.md")).toBe("s".length);
    expect(renameStemLength("f.d2.json")).toBe("f".length);
    expect(renameStemLength("top.mdx")).toBe("top".length);
  });
});
