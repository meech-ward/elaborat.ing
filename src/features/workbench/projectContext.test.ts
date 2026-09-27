import { describe, expect, test } from "bun:test";
import {
  createProjectContext,
  MAX_PROJECT_CONTEXT_TABS,
  parseProjectContext,
  PROJECT_CONTEXT_VERSION,
} from "./projectContext";

const A = "notes/a.md";
const B = "notes/b.md";
const C = "notes/c.md";

describe("parseProjectContext", () => {
  test("a valid record keeps order, active tab and per-file views", () => {
    expect(
      parseProjectContext({
        version: PROJECT_CONTEXT_VERSION,
        openPaths: [A, B, C],
        activePath: B,
        views: { [A]: "split", [B]: "rendered", [C]: "canvas" },
      }),
    ).toEqual({
      version: PROJECT_CONTEXT_VERSION,
      openPaths: [A, B, C],
      activePath: B,
      views: { [A]: "split", [B]: "rendered", [C]: "canvas" },
    });
  });

  test("an explicitly empty context stays empty and distinct from no record", () => {
    expect(
      parseProjectContext({
        version: PROJECT_CONTEXT_VERSION,
        openPaths: [],
        activePath: null,
        views: {},
      }),
    ).toEqual({
      version: PROJECT_CONTEXT_VERSION,
      openPaths: [],
      activePath: null,
      views: {},
    });
    expect(parseProjectContext(null)).toBeNull();
  });

  test("malformed records fall back to null", () => {
    for (const value of [
      null,
      undefined,
      "context",
      7,
      [],
      {},
      { version: PROJECT_CONTEXT_VERSION },
      { openPaths: [A], activePath: A, views: {} },
      { version: 2, openPaths: [A], activePath: A, views: {} },
      { version: "1", openPaths: [A], activePath: A, views: {} },
      {
        version: PROJECT_CONTEXT_VERSION,
        openPaths: A,
        activePath: A,
        views: {},
      },
      {
        version: PROJECT_CONTEXT_VERSION,
        openPaths: [A],
        activePath: 7,
        views: {},
      },
      {
        version: PROJECT_CONTEXT_VERSION,
        openPaths: [A],
        activePath: A,
        views: { [A]: "preview" },
      },
      {
        version: PROJECT_CONTEXT_VERSION,
        openPaths: [A],
        activePath: A,
        views: [{ [A]: "source" }],
      },
      {
        version: PROJECT_CONTEXT_VERSION,
        openPaths: [A],
        activePath: A,
      },
      {
        version: PROJECT_CONTEXT_VERSION,
        openPaths: [""],
        activePath: null,
        views: {},
      },
    ])
      expect(parseProjectContext(value)).toBeNull();
  });

  test("oversized payloads are rejected rather than processed", () => {
    const many = Array.from({ length: 5000 }, (_, n) => `notes/n${n}.md`);
    expect(
      parseProjectContext({
        version: PROJECT_CONTEXT_VERSION,
        openPaths: many,
        activePath: null,
        views: {},
      }),
    ).toBeNull();
    const manyViews: Record<string, "source"> = {};
    for (let n = 0; n < 5000; n++) manyViews[`notes/v${n}.md`] = "source";
    expect(
      parseProjectContext({
        version: PROJECT_CONTEXT_VERSION,
        openPaths: [A],
        activePath: A,
        views: manyViews,
      }),
    ).toBeNull();
    expect(
      parseProjectContext({
        version: PROJECT_CONTEXT_VERSION,
        openPaths: [`notes/${"x".repeat(600)}.md`],
        activePath: null,
        views: {},
      }),
    ).toBeNull();
  });

  test("bytes, drafts and tokens are stripped, never stored", () => {
    const parsed = parseProjectContext({
      version: PROJECT_CONTEXT_VERSION,
      openPaths: [A, B],
      activePath: B,
      views: { [A]: "source" },
      content: "SECRET-DOC-TEXT",
      bytes: "SECRET-BYTES",
      drafts: { [A]: "unsaved" },
      tokens: ["SECRET-TOKEN"],
      revision: "deadbeef",
    });
    expect(parsed).toEqual({
      version: PROJECT_CONTEXT_VERSION,
      openPaths: [A, B],
      activePath: B,
      views: { [A]: "source" },
    });
    expect(JSON.stringify(parsed)).not.toContain("SECRET");
  });

  test("invalid paths are filtered, duplicates removed, length bounded", () => {
    const many = Array.from(
      { length: MAX_PROJECT_CONTEXT_TABS + 10 },
      (_, n) => `notes/n${n}.md`,
    );
    const parsed = parseProjectContext({
      version: PROJECT_CONTEXT_VERSION,
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
      views: {},
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.openPaths[0]).toBe(A);
    expect(parsed!.openPaths[1]).toBe(B);
    expect(parsed!.openPaths).toHaveLength(MAX_PROJECT_CONTEXT_TABS);
    expect(new Set(parsed!.openPaths).size).toBe(parsed!.openPaths.length);
  });

  test("a record with only invalid paths falls back to null", () => {
    expect(
      parseProjectContext({
        version: PROJECT_CONTEXT_VERSION,
        openPaths: ["../secret.md", "/abs.md"],
        activePath: "../secret.md",
        views: {},
      }),
    ).toBeNull();
  });

  test("an active path outside the open set falls back deterministically", () => {
    expect(
      parseProjectContext({
        version: PROJECT_CONTEXT_VERSION,
        openPaths: [A, B],
        activePath: C,
        views: {},
      }),
    ).toEqual({
      version: PROJECT_CONTEXT_VERSION,
      openPaths: [A, B],
      activePath: B,
      views: {},
    });
    expect(
      parseProjectContext({
        version: PROJECT_CONTEXT_VERSION,
        openPaths: [A, B],
        activePath: null,
        views: {},
      }),
    ).toEqual({
      version: PROJECT_CONTEXT_VERSION,
      openPaths: [A, B],
      activePath: B,
      views: {},
    });
    expect(
      parseProjectContext({
        version: PROJECT_CONTEXT_VERSION,
        openPaths: [],
        activePath: A,
        views: {},
      }),
    ).toEqual({
      version: PROJECT_CONTEXT_VERSION,
      openPaths: [],
      activePath: null,
      views: {},
    });
  });

  test("views survive only for open paths", () => {
    expect(
      parseProjectContext({
        version: PROJECT_CONTEXT_VERSION,
        openPaths: [A, B],
        activePath: A,
        views: {
          [A]: "code",
          [C]: "canvas",
          "../secret.md": "source",
          "notes/.hidden.md": "rendered",
        },
      }),
    ).toEqual({
      version: PROJECT_CONTEXT_VERSION,
      openPaths: [A, B],
      activePath: A,
      views: { [A]: "code" },
    });
  });

  test("literal %, %20, # and ? persist as exact identities", () => {
    const pct = "notes/100%.md";
    const pct20 = "notes/100%20off.md";
    const hash = "notes/a#b.md";
    const query = "notes/a?b.md";
    const space = "notes/my file.md";
    const encodedLike = "notes/my%20file.md";
    const openPaths = [pct, pct20, hash, query, space, encodedLike];
    expect(
      parseProjectContext({
        version: PROJECT_CONTEXT_VERSION,
        openPaths,
        activePath: pct20,
        views: { [pct]: "source", [encodedLike]: "rendered" },
      }),
    ).toEqual({
      version: PROJECT_CONTEXT_VERSION,
      openPaths,
      activePath: pct20,
      views: { [pct]: "source", [encodedLike]: "rendered" },
    });
  });
});

describe("createProjectContext", () => {
  test("creation yields a coherent versioned snapshot", () => {
    expect(createProjectContext([A, B], B, { [A]: "source" })).toEqual({
      version: 1,
      openPaths: [A, B],
      activePath: B,
      views: { [A]: "source" },
    });
    expect(createProjectContext([], null, {})).toEqual({
      version: 1,
      openPaths: [],
      activePath: null,
      views: {},
    });
  });

  test("duplicates are removed with order retained; views follow", () => {
    expect(
      createProjectContext([B, A, B, C, A], A, {
        [A]: "rendered",
        [B]: "code",
        [C]: "canvas",
      }),
    ).toEqual({
      version: 1,
      openPaths: [B, A, C],
      activePath: A,
      views: { [A]: "rendered", [B]: "code", [C]: "canvas" },
    });
  });

  test("active and views resolve against the cleaned open set", () => {
    expect(
      createProjectContext([A, "../secret.md", B], C, {
        [C]: "canvas",
        [B]: "code",
      }),
    ).toEqual({
      version: 1,
      openPaths: [A, B],
      activePath: B,
      views: { [B]: "code" },
    });
  });

  test("creation never exceeds the tab bound", () => {
    const many = Array.from({ length: 60 }, (_, n) => `notes/n${n}.md`);
    const created = createProjectContext(many, many[59]!, {});
    expect(created.openPaths).toHaveLength(MAX_PROJECT_CONTEXT_TABS);
    expect(created.openPaths).toEqual(many.slice(0, MAX_PROJECT_CONTEXT_TABS));
    expect(created.activePath).toBe(many[MAX_PROJECT_CONTEXT_TABS - 1]);
  });
});
