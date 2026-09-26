import { describe, expect, test } from "bun:test";
import {
  ancestorsOf,
  buildFolderTree,
  folderNameError,
  isCanonicalDirectoryPath,
  joinFolder,
  parentDirOf,
  revealAncestors,
} from "./folderTree";

describe("parentDirOf/ancestorsOf/joinFolder", () => {
  test("root children have no parent and join at the root", () => {
    expect(parentDirOf("top.md")).toBe("");
    expect(parentDirOf("a/b/note.md")).toBe("a/b");
    expect(ancestorsOf("top.md")).toEqual([]);
    expect(ancestorsOf("a/b/note.md")).toEqual(["a", "a/b"]);
    expect(joinFolder("", "fresh")).toBe("fresh");
    expect(joinFolder("a/b", "fresh")).toBe("a/b/fresh");
  });
});

describe("isCanonicalDirectoryPath", () => {
  test("accepts nested and special-character identities without decoding", () => {
    expect(isCanonicalDirectoryPath("documents/customer-model")).toBe(true);
    expect(isCanonicalDirectoryPath("100% real")).toBe(true);
    expect(isCanonicalDirectoryPath("a%2Fb")).toBe(true);
    expect(isCanonicalDirectoryPath("what #1?")).toBe(true);
    expect(isCanonicalDirectoryPath("Zürich/notes")).toBe(true);
  });

  test("refuses root, traversal, dotfiles, and empty segments", () => {
    expect(isCanonicalDirectoryPath("")).toBe(false);
    expect(isCanonicalDirectoryPath("a/../b")).toBe(false);
    expect(isCanonicalDirectoryPath("a//b")).toBe(false);
    expect(isCanonicalDirectoryPath("/a")).toBe(false);
    expect(isCanonicalDirectoryPath("a/")).toBe(false);
    expect(isCanonicalDirectoryPath(".hidden")).toBe(false);
    expect(isCanonicalDirectoryPath("a/.hidden")).toBe(false);
    expect(isCanonicalDirectoryPath("a/./b")).toBe(false);
  });
});

describe("buildFolderTree", () => {
  test("nests folders with basename labels and exact full-path identities", () => {
    const tree = buildFolderTree(
      ["documents/customer-model/note.mdx", "top.md"],
      ["documents", "documents/customer-model"],
    );
    expect(tree.rootFiles).toEqual([{ path: "top.md", draft: false }]);
    expect(tree.folders.map((folder) => folder.path)).toEqual(["documents"]);
    const docs = tree.folders[0];
    expect(docs.name).toBe("documents");
    expect(docs.folders.map((folder) => folder.path)).toEqual([
      "documents/customer-model",
    ]);
    expect(docs.folders[0].name).toBe("customer-model");
    expect(docs.folders[0].files).toEqual([
      { path: "documents/customer-model/note.mdx", draft: false },
    ]);
  });

  test("keeps explicit empty directories and implies file ancestors", () => {
    const tree = buildFolderTree(["a/b/note.md"], ["empty"]);
    const paths = (nodes: { path: string }[]) => nodes.map((n) => n.path);
    expect(paths(tree.folders)).toEqual(["a", "empty"]);
    expect(paths(tree.folders[0].folders)).toEqual(["a/b"]);
    expect(tree.folders[1].files).toEqual([]);
  });

  test("sorts folders before files with deterministic sibling order", () => {
    const tree = buildFolderTree(
      ["root/zebra.md", "root/apple.md", "root/nested/note.md"],
      ["root/nested", "root/alpha"],
    );
    const root = tree.folders.find((folder) => folder.path === "root");
    expect(root?.folders.map((folder) => folder.name)).toEqual([
      "alpha",
      "nested",
    ]);
    expect(root?.files.map((file) => file.path)).toEqual([
      "root/apple.md",
      "root/zebra.md",
    ]);
  });

  test("marks unsaved drafts without posing as server files", () => {
    const tree = buildFolderTree(["notes/saved.md"], ["notes"], [
      "notes/untitled.md",
      "notes/saved.md",
    ]);
    const notes = tree.folders.find((folder) => folder.path === "notes");
    expect(notes?.files).toEqual([
      { path: "notes/saved.md", draft: false },
      { path: "notes/untitled.md", draft: true },
    ]);
  });

  test("skips invalid directory identities while keeping valid siblings", () => {
    const tree = buildFolderTree([], ["ok", "../escape", "ok/../also-bad"]);
    expect(tree.folders.map((folder) => folder.path)).toEqual(["ok"]);
  });
});

describe("folderNameError", () => {
  test("accepts one new child basename in a folder or the root", () => {
    expect(folderNameError("notes", "fresh", ["notes"], [])).toBeNull();
    expect(folderNameError("", "fresh", [], [])).toBeNull();
    expect(folderNameError("", "100% real", [], [])).toBeNull();
  });

  test("refuses empty, unsafe, and padded names", () => {
    expect(folderNameError("", "", [], [])).toMatch(/Enter a folder name/);
    expect(folderNameError("", "   ", [], [])).toMatch(/Enter a folder name/);
    expect(folderNameError("", "a/b", [], [])).toMatch(/one folder name/);
    expect(folderNameError("", ".hidden", [], [])).toMatch(/one folder name/);
    expect(folderNameError("", "..", [], [])).toMatch(/one folder name/);
    expect(folderNameError("", " padded ", [], [])).toMatch(/start or end/);
  });

  test("refuses collisions with existing directories and files", () => {
    expect(folderNameError("notes", "sub", ["notes/sub"], [])).toMatch(
      /already exists/,
    );
    expect(folderNameError("", "notes", [], ["notes"])).toMatch(/already exists/);
  });

  test("refuses creation under a vanished parent", () => {
    expect(folderNameError("../gone", "fresh", [], [])).toMatch(
      /no longer available/,
    );
  });
});

describe("revealAncestors", () => {
  test("adds the file's ancestor chain without duplicates", () => {
    expect(revealAncestors(["other"], "a/b/note.md")).toEqual([
      "other",
      "a",
      "a/b",
    ]);
    expect(revealAncestors(["a", "a/b"], "a/b/note.md")).toEqual(["a", "a/b"]);
    expect(revealAncestors([], "top.md")).toEqual([]);
  });

  test("stays bounded", () => {
    expect(revealAncestors([], "a/b/note.md", 1)).toEqual(["a"]);
  });

  test("reveals the opened file when 64 unrelated folders are already expanded", () => {
    const expanded = Array.from({ length: 64 }, (_, i) => `unrelated-${i}`);
    const snapshot = [...expanded];
    const result = revealAncestors(expanded, "a/b/note.md");
    expect(result).toContain("a");
    expect(result).toContain("a/b");
    expect(result.length).toBeLessThanOrEqual(64);
    expect(new Set(result).size).toBe(result.length);
    for (const entry of result) {
      expect(
        entry === "a" || entry === "a/b" || snapshot.includes(entry),
      ).toBe(true);
    }
    expect(expanded).toEqual(snapshot);
  });
});
