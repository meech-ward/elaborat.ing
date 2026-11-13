import { expect, test } from "bun:test";
import { EXPLORER_FILE_DRAG_TYPE, isExplorerFileDrag, readExplorerFileDrag, writeExplorerFileDrag } from "./explorerDrag";

test("native file drags retain exact canonical identities and request a move", () => {
  const values = new Map<string, string>();
  const transfer = { effectAllowed: "none" as DataTransfer["effectAllowed"], setData: (type: string, value: string) => { values.set(type, value); }, getData: (type: string) => values.get(type) ?? "" };
  const path = "notes/100%25.md";
  writeExplorerFileDrag(transfer, path, "this-tree");
  expect(transfer.effectAllowed).toBe("move");
  expect(readExplorerFileDrag(transfer, "this-tree", new Set([path]))).toBe(path);
  expect(isExplorerFileDrag({ types: [...values.keys()] })).toBe(true);
});

test("foreign, missing, forged and invalid drag identities cannot request a move", () => {
  const read = (payload: unknown, source = "this-tree", paths = new Set(["notes/plan.md"])) =>
    readExplorerFileDrag({ getData: () => JSON.stringify(payload) }, source, paths);
  const payload = { version: 1, source: "this-tree", path: "notes/plan.md" };
  expect(read(payload, "another-tree")).toBeNull();
  expect(read(payload, "this-tree", new Set())).toBeNull();
  for (const invalid of [null, "notes/plan.md", {}, { ...payload, version: 2 }, { ...payload, extra: true }, { ...payload, path: "../plan.md" }, { ...payload, path: "notes/no-extension" }]) {
    expect(read(invalid)).toBeNull();
  }
  expect(readExplorerFileDrag({ getData: () => "{" }, "this-tree", new Set())).toBeNull();
  expect(readExplorerFileDrag({ getData: () => "x".repeat(2049) }, "this-tree", new Set())).toBeNull();
});

test("external uploads and ordinary text never become internal file moves", () => {
  expect(isExplorerFileDrag({ types: ["Files"] })).toBe(false);
  expect(isExplorerFileDrag({ types: ["text/plain"] })).toBe(false);
  expect(isExplorerFileDrag({ types: [EXPLORER_FILE_DRAG_TYPE, "Files"] })).toBe(false);
});
