import { describe, expect, test } from "bun:test";
import {
  basenameForPath,
  canHoldWorkspaceRefs,
  diagramPartnerPaths,
  renameDestinationPath,
  validateWorkspaceBasename,
  workspacePathSuffix,
} from "../index.ts";


describe("rename path policy", () => {
  test("canonical percent literals never retarget a different folder", () => {
    expect(renameDestinationPath("a%20b/original.md", "next.md")).toBeNull();
    expect(renameDestinationPath("notes/100%.md", "next.md")).toBe("notes/next.md");
  });
  test("basename accepts one segment and refuses separators/dots/controls", () => {
    expect(validateWorkspaceBasename("next.md")).toBe("next.md");
    expect(validateWorkspaceBasename("my drawing #1?.md")).toBe("my drawing #1?.md");
    expect(validateWorkspaceBasename("sub/next.md")).toBeNull();
    expect(validateWorkspaceBasename("a\\b.md")).toBeNull();
    expect(validateWorkspaceBasename(".hidden.md")).toBeNull();
    expect(validateWorkspaceBasename("..")).toBeNull();
    expect(validateWorkspaceBasename("")).toBeNull();
    expect(validateWorkspaceBasename("a\0b.md")).toBeNull();
    expect(validateWorkspaceBasename("a\nb.md")).toBeNull();
    expect(validateWorkspaceBasename("x".repeat(256))).toBeNull();
  });

  test("destination stays in the source folder with the same extension", () => {
    expect(renameDestinationPath("notes/plan.md", "next.md")).toBe("notes/next.md");
    expect(renameDestinationPath("top.mdx", "renamed.mdx")).toBe("renamed.mdx");
    expect(renameDestinationPath("a/b/flow.d2", "schema.d2")).toBe("a/b/schema.d2");
    expect(renameDestinationPath("notes/plan.md", "plan.md")).toBeNull();
    expect(renameDestinationPath("notes/plan.md", "plan.mdx")).toBeNull();
    expect(renameDestinationPath("notes/plan.md", "sub/next.md")).toBeNull();
    expect(renameDestinationPath("../outside.md", "x.md")).toBeNull();
    expect(renameDestinationPath("notes/plan.md", "noext")).toBeNull();
  });

  test("compound suffixes compare exactly", () => {
    expect(workspacePathSuffix("s.excalidraw.md")).toBe(".excalidraw.md");
    expect(workspacePathSuffix("s.md")).toBe(".md");
    expect(workspacePathSuffix("f.d2.json")).toBe(".d2.json");
    expect(workspacePathSuffix("meta.json")).toBe(".json");
    expect(workspacePathSuffix("nope.exe")).toBeNull();
    expect(renameDestinationPath("s.excalidraw.md", "t.excalidraw.md")).toBe("t.excalidraw.md");
    expect(renameDestinationPath("s.excalidraw.md", "t.md")).toBeNull();
    expect(renameDestinationPath("f.d2.json", "g.json")).toBeNull();
  });

  test("encoded destinations that decode differently are refused", () => {
    expect(renameDestinationPath("notes/plan.md", "a%2fmd")).toBeNull();
    expect(renameDestinationPath("notes/plan.md", "100%.md")).toBeNull();
    expect(renameDestinationPath("notes/plan.md", "ok #1?.md")).toBe("notes/ok #1?.md");
  });

  test("basename and ref-source helpers", () => {
    expect(basenameForPath("notes/plan.md")).toBe("plan.md");
    expect(basenameForPath("top.md")).toBe("top.md");
    expect(canHoldWorkspaceRefs("notes/a.md")).toBe(true);
    expect(canHoldWorkspaceRefs("notes/a.mdx")).toBe(true);
    expect(canHoldWorkspaceRefs("pic.excalidraw")).toBe(false);
    expect(canHoldWorkspaceRefs("flow.d2")).toBe(false);
  });

  test("diagram partners mirror the workbench companion derivations", () => {
    // name.d2 pairs with name.excalidraw and name.d2.json.
    expect(diagramPartnerPaths("diagrams/flow.d2")).toEqual([
      "diagrams/flow.excalidraw",
      "diagrams/flow.d2.json",
    ]);
    expect(diagramPartnerPaths("diagrams/flow.excalidraw")).toEqual(["diagrams/flow.d2"]);
    expect(diagramPartnerPaths("diagrams/flow.d2.json")).toEqual(["diagrams/flow.d2"]);
    expect(diagramPartnerPaths("notes/plan.md")).toEqual([]);
    expect(diagramPartnerPaths("scene.excalidraw.md")).toEqual([]);
  });
});

