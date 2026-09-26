import { describe, expect, test } from "bun:test";
import {
  FOLDER_STORAGE_KEY,
  MAX_EXPANDED_FOLDERS,
  followFolderMove,
  parseFolderPreferences,
  pruneFolderPreferences,
  readFolderPreferences,
  writeFolderPreferences,
  type FolderPreferences,
} from "./folderPreferences";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => (data.has(key) ? data.get(key)! : null),
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    data,
  };
}

describe("parseFolderPreferences", () => {
  test("accepts a valid record with an explicit root selection", () => {
    expect(
      parseFolderPreferences({
        version: 1,
        expanded: ["notes", "notes/sub"],
        selectedFolder: "",
      }),
    ).toEqual({ expanded: ["notes", "notes/sub"], selectedFolder: "" });
  });

  test("falls back to defaults for missing, malformed, or wrong-version input", () => {
    const defaults = { expanded: [], selectedFolder: null };
    expect(parseFolderPreferences(null)).toEqual(defaults);
    expect(parseFolderPreferences(undefined)).toEqual(defaults);
    expect(parseFolderPreferences("nope")).toEqual(defaults);
    expect(
      parseFolderPreferences({ version: 2, expanded: [], selectedFolder: null }),
    ).toEqual(defaults);
    expect(
      parseFolderPreferences({
        version: 1,
        expanded: "notes",
        selectedFolder: null,
      }),
    ).toEqual(defaults);
  });

  test("drops unusable entries while keeping usable ones", () => {
    expect(
      parseFolderPreferences({
        version: 1,
        expanded: ["notes", "../escape", "a//b", "notes", ".hidden"],
        selectedFolder: "../escape",
      }),
    ).toEqual({ expanded: ["notes"], selectedFolder: null });
  });

  test("bounds the expanded list", () => {
    const expanded = Array.from(
      { length: MAX_EXPANDED_FOLDERS + 10 },
      (_, i) => `folder-${i}`,
    );
    const parsed = parseFolderPreferences({
      version: 1,
      expanded,
      selectedFolder: "folder-0",
    });
    expect(parsed.expanded).toHaveLength(MAX_EXPANDED_FOLDERS);
    expect(parsed.selectedFolder).toBe("folder-0");
  });
});

describe("readFolderPreferences/writeFolderPreferences", () => {
  test("round-trips through storage", () => {
    const storage = memoryStorage();
    const value: FolderPreferences = {
      expanded: ["notes"],
      selectedFolder: "notes",
    };
    writeFolderPreferences(storage, value);
    expect(readFolderPreferences(storage)).toEqual(value);
    expect(JSON.parse(storage.data.get(FOLDER_STORAGE_KEY)!).version).toBe(1);
  });

  test("unavailable or failing storage never blocks use", () => {
    expect(readFolderPreferences(null)).toEqual({
      expanded: [],
      selectedFolder: null,
    });
    expect(readFolderPreferences(undefined)).toEqual({
      expanded: [],
      selectedFolder: null,
    });
    expect(
      readFolderPreferences(memoryStorage({ [FOLDER_STORAGE_KEY]: "{bad json" })),
    ).toEqual({ expanded: [], selectedFolder: null });
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(readFolderPreferences(throwing)).toEqual({
      expanded: [],
      selectedFolder: null,
    });
    expect(() =>
      writeFolderPreferences(throwing, { expanded: [], selectedFolder: null }),
    ).not.toThrow();
    expect(() =>
      writeFolderPreferences(null, { expanded: [], selectedFolder: null }),
    ).not.toThrow();
  });
});

describe("pruneFolderPreferences", () => {
  test("drops vanished folders and selections after a successful list", () => {
    expect(
      pruneFolderPreferences(
        { expanded: ["notes", "gone"], selectedFolder: "gone" },
        ["notes"],
      ),
    ).toEqual({ expanded: ["notes"], selectedFolder: null });
  });

  test("keeps the explicit root selection and draft-backed folders", () => {
    const prefs: FolderPreferences = {
      expanded: ["notes", "drafts-only"],
      selectedFolder: "",
    };
    expect(pruneFolderPreferences(prefs, ["notes", "drafts-only"])).toBe(prefs);
    expect(
      pruneFolderPreferences({ expanded: [], selectedFolder: "" }, []),
    ).toEqual({ expanded: [], selectedFolder: "" });
  });
});

describe("followFolderMove", () => {
  test("a moved folder's expanded folders and selection go with it, and the old paths wait for a list to prune them", () => {
    const prefs: FolderPreferences = { expanded: ["docs", "docs/art", "docs-old", "other"], selectedFolder: "docs/art" };
    const next = followFolderMove(prefs, "docs", "notes");
    expect(next).toEqual({ expanded: ["notes", "notes/art", "docs", "docs/art", "docs-old", "other"], selectedFolder: "notes/art" });
    expect(pruneFolderPreferences(next, ["notes", "notes/art", "docs-old", "other"])).toEqual({
      expanded: ["notes", "notes/art", "docs-old", "other"],
      selectedFolder: "notes/art",
    });
  });

  test("preferences outside the folder are returned as they are", () => {
    const prefs: FolderPreferences = { expanded: ["docs-old"], selectedFolder: "" };
    expect(followFolderMove(prefs, "docs", "archive/docs")).toBe(prefs);
  });
});
