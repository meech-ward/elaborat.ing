import { describe, expect, test } from "bun:test";
import { MissingFileError } from "./workspaceStore";
import { emptyTabs, tabTransition } from "./tabs";
import {
  MAX_PERSISTED_TABS,
  TAB_PERSISTENCE_VERSION,
  TAB_STORAGE_KEY,
  isMissingFileError,
  parsePersistedTabs,
  readPersistedTabs,
  retainUnrestoredTabs,
  toPersistedTabs,
  writePersistedTabs,
} from "./tabPersistence";

const A = "notes/a.md";
const B = "notes/b.md";
const C = "notes/c.md";
const SAVED = [A, B, C];

test("a transient read preserves only unresolved identities across selection, close and new open", () => {
  const remembered = { openPaths: [A, B, C], activePath: B };
  expect(
    retainUnrestoredTabs({ openPaths: [A, C], activePath: A }, remembered, [B]),
  ).toEqual({ openPaths: [A, B, C], activePath: A });
  expect(
    retainUnrestoredTabs(
      { openPaths: [C, "notes/new.md"], activePath: "notes/new.md" },
      remembered,
      [B],
    ),
  ).toEqual({ openPaths: [B, C, "notes/new.md"], activePath: "notes/new.md" });
  expect(
    retainUnrestoredTabs({ openPaths: [C], activePath: C }, remembered, []),
  ).toEqual({ openPaths: [C], activePath: C });
});

function memoryStorage(initial?: Record<string, string>) {
  const map = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    raw: (key: string) => map.get(key),
  };
}

describe("parsePersistedTabs", () => {
  test("valid records keep order and the middle active tab", () => {
    expect(
      parsePersistedTabs({
        version: TAB_PERSISTENCE_VERSION,
        openPaths: [A, B, C],
        activePath: B,
      }),
    ).toEqual({ openPaths: [A, B, C], activePath: B });
  });

  test("an explicitly empty set stays empty and distinct from no record", () => {
    expect(
      parsePersistedTabs({
        version: TAB_PERSISTENCE_VERSION,
        openPaths: [],
        activePath: null,
      }),
    ).toEqual({ openPaths: [], activePath: null });
    expect(readPersistedTabs(memoryStorage())).toBeNull();
  });

  test("malformed records fall back to null", () => {
    for (const value of [
      null,
      "tabs",
      [],
      {},
      { version: TAB_PERSISTENCE_VERSION },
      { openPaths: [A], activePath: A },
      { version: 2, openPaths: [A], activePath: A },
      { version: "1", openPaths: [A], activePath: A },
      { version: TAB_PERSISTENCE_VERSION, openPaths: A, activePath: A },
      { version: TAB_PERSISTENCE_VERSION, openPaths: [A], activePath: 7 },
      { version: TAB_PERSISTENCE_VERSION, openPaths: [""], activePath: null },
    ])
      expect(parsePersistedTabs(value)).toBeNull();
  });

  test("extra content, revisions and drafts are stripped, not trusted", () => {
    expect(
      parsePersistedTabs({
        version: TAB_PERSISTENCE_VERSION,
        openPaths: [A, B],
        activePath: B,
        content: "SECRET-DOC-TEXT",
        revision: "deadbeef",
        drafts: { [A]: "unsaved" },
      }),
    ).toEqual({ openPaths: [A, B], activePath: B });
  });

  test("invalid paths are filtered, duplicates removed, length bounded", () => {
    const many = Array.from(
      { length: MAX_PERSISTED_TABS + 10 },
      (_, n) => `notes/n${n}.md`,
    );
    const parsed = parsePersistedTabs({
      version: TAB_PERSISTENCE_VERSION,
      openPaths: [
        A,
        "../secret.md",
        A,
        "/abs.md",
        ".h/a.md",
        "notes/.hidden.md",
        B,
        ...many,
      ],
      activePath: B,
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.openPaths[0]).toBe(A);
    expect(parsed!.openPaths[1]).toBe(B);
    expect(parsed!.openPaths).toHaveLength(MAX_PERSISTED_TABS);
    expect(new Set(parsed!.openPaths).size).toBe(parsed!.openPaths.length);
  });

  test("a record with only invalid paths falls back to null", () => {
    expect(
      parsePersistedTabs({
        version: TAB_PERSISTENCE_VERSION,
        openPaths: ["../secret.md", "/abs.md"],
        activePath: "../secret.md",
      }),
    ).toBeNull();
  });

  test("an active path outside the open set falls back to the last tab", () => {
    expect(
      parsePersistedTabs({
        version: TAB_PERSISTENCE_VERSION,
        openPaths: [A, B],
        activePath: C,
      }),
    ).toEqual({ openPaths: [A, B], activePath: B });
    expect(
      parsePersistedTabs({
        version: TAB_PERSISTENCE_VERSION,
        openPaths: [A, B],
        activePath: "../secret.md",
      }),
    ).toEqual({ openPaths: [A, B], activePath: B });
    expect(
      parsePersistedTabs({
        version: TAB_PERSISTENCE_VERSION,
        openPaths: [],
        activePath: A,
      }),
    ).toEqual({ openPaths: [], activePath: null });
  });
});

describe("read/writePersistedTabs", () => {
  test("round-trips path metadata only, never document text", () => {
    const storage = memoryStorage();
    const tabs = [
      { path: A, content: "SECRET-DOC-TEXT-A" },
      { path: B, content: "SECRET-DOC-TEXT-B" },
    ];
    writePersistedTabs(storage, toPersistedTabs(tabs, B, SAVED));
    const raw = storage.raw(TAB_STORAGE_KEY)!;
    expect(raw).not.toContain("SECRET");
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual([
      "activePath",
      "openPaths",
      "version",
    ]);
    expect(readPersistedTabs(storage)).toEqual({
      openPaths: [A, B],
      activePath: B,
    });
  });

  test("malformed JSON and unavailable storage fall back safely", () => {
    expect(
      readPersistedTabs(memoryStorage({ [TAB_STORAGE_KEY]: "{broken" })),
    ).toBeNull();
    expect(readPersistedTabs(null)).toBeNull();
    expect(readPersistedTabs(undefined)).toBeNull();
    expect(
      readPersistedTabs({
        getItem: () => {
          throw new Error("denied");
        },
      }),
    ).toBeNull();
    expect(() =>
      writePersistedTabs(null, { openPaths: [A], activePath: A }),
    ).not.toThrow();
    expect(() =>
      writePersistedTabs(
        {
          setItem: () => {
            throw new Error("quota");
          },
        },
        { openPaths: [A], activePath: A },
      ),
    ).not.toThrow();
  });
});

describe("toPersistedTabs", () => {
  test("keeps saved-file order and the active tab; drafts are excluded", () => {
    const tabs = [
      { path: A },
      { path: "notes/draft.md" },
      { path: B },
      { path: C },
    ];
    expect(toPersistedTabs(tabs, B, SAVED)).toEqual({
      openPaths: [A, B, C],
      activePath: B,
    });
  });

  test("an active draft falls back to the last saved tab", () => {
    const tabs = [{ path: A }, { path: "notes/draft.md" }];
    expect(toPersistedTabs(tabs, "notes/draft.md", [A])).toEqual({
      openPaths: [A],
      activePath: A,
    });
    expect(
      toPersistedTabs([{ path: "notes/draft.md" }], "notes/draft.md", []),
    ).toEqual({
      openPaths: [],
      activePath: null,
    });
  });

  test("closing one tab stays closed in the projected record", () => {
    expect(toPersistedTabs([{ path: A }, { path: C }], C, SAVED)).toEqual({
      openPaths: [A, C],
      activePath: C,
    });
  });
});

describe("canonical path identity", () => {
  test("literal %, %20, # and ? persist as exact identities, distinct from decoded forms", () => {
    const pct = "notes/100%.md";
    const pct20 = "notes/100%20off.md";
    const hash = "notes/a#b.md";
    const query = "notes/a?b.md";
    const space = "notes/my file.md";
    const encodedLike = "notes/my%20file.md";
    const saved = [pct, pct20, hash, query, space, encodedLike];
    const projected = toPersistedTabs(
      saved.map((path) => ({ path })),
      pct20,
      saved,
    );
    // Nothing decoded, nothing dropped, active selection preserved raw.
    expect(projected).toEqual({ openPaths: saved, activePath: pct20 });
    const storage = memoryStorage();
    writePersistedTabs(storage, projected);
    expect(readPersistedTabs(storage)).toEqual({
      openPaths: saved,
      activePath: pct20,
    });
  });
});

describe("isMissingFileError", () => {
  test("only a missing file drops a remembered tab; other failures are temporary", () => {
    expect(isMissingFileError(new MissingFileError("notes/a.md"))).toBe(true);
    expect(isMissingFileError(new Error("storage failed"))).toBe(false);
    expect(isMissingFileError(null)).toBe(false);
  });
});

describe("tabTransition restored", () => {
  const file = (path: string) => ({
    path,
    content: `${path} bytes`,
    revision: `${path}#1`,
  });

  test("restores order with the remembered active tab from server bytes", () => {
    const state = tabTransition(emptyTabs, {
      type: "restored",
      files: [file(A), file(B), file(C)],
      activePath: B,
    });
    expect(state.tabs.map((t) => t.path)).toEqual([A, B, C]);
    expect(state.active).toBe(B);
    expect(state.tabs[1]).toMatchObject({
      content: `${B} bytes`,
      dirty: false,
    });
  });

  test("a newer user selection wins and duplicates are skipped", () => {
    let state = tabTransition(emptyTabs, {
      type: "request",
      sequence: 1,
    });
    state = tabTransition(state, {
      type: "opened",
      sequence: 1,
      file: file("notes/d.md"),
    });
    const retained = state.tabs[0];
    state = tabTransition(state, {
      type: "restored",
      files: [file(A), file(B)],
      activePath: A,
    });
    expect(state.tabs.map((t) => t.path)).toEqual(["notes/d.md", A, B]);
    expect(state.active).toBe("notes/d.md");
    expect(state.tabs[0]).toBe(retained);

    // The user opened a remembered path first: keep that session, keep selection.
    let dup = tabTransition(emptyTabs, { type: "request", sequence: 1 });
    dup = tabTransition(dup, { type: "opened", sequence: 1, file: file(A) });
    const first = dup.tabs[0];
    dup = tabTransition(dup, {
      type: "restored",
      files: [file(A), file(B)],
      activePath: B,
    });
    expect(dup.tabs.map((t) => t.path)).toEqual([A, B]);
    expect(dup.active).toBe(A);
    expect(dup.tabs[0]).toBe(first);
  });

  test("unknown remembered actives fall back without resurrecting", () => {
    const state = tabTransition(emptyTabs, {
      type: "restored",
      files: [file(A)],
      activePath: "notes/gone.md",
    });
    expect(state.tabs.map((t) => t.path)).toEqual([A]);
    expect(state.active).toBe(A);
    expect(state.sequence).toBe(emptyTabs.sequence);
    const noop = tabTransition(state, {
      type: "restored",
      files: [file(A)],
      activePath: A,
    });
    expect(noop).toBe(state);
    expect(
      tabTransition(emptyTabs, {
        type: "restored",
        files: [],
        activePath: null,
      }),
    ).toBe(emptyTabs);
  });
});
