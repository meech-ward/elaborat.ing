import { expect, test } from "bun:test";
import { checkParentMessage, PREVIEW_CHILD_CSP } from "./protocol";
test("appearance is bounded presentation input bound to the established frame session", () => {
  const data = {
    kind: "appearance",
    session: "session-accepted",
    theme: "cherry-paper",
    scheme: "light",
  };
  const check = (
    value: unknown,
    activeSession: string | null = "session-accepted",
    source: unknown = {},
  ) => checkParentMessage({ data: value, source, activeSession });
  expect(check(data).ok).toBe(true);
  expect(check(data, "session-other").ok).toBe(false);
  expect(check(data, "session-accepted", null).ok).toBe(false);
  expect(check({ ...data, theme: "url(https://example.com)" }).ok).toBe(false);
  expect(check({ ...data, theme: "paper" }).ok).toBe(false);
  expect(check({ ...data, scheme: "system" }).ok).toBe(false);
  expect(PREVIEW_CHILD_CSP).toContain("font-src data:;");
  expect(PREVIEW_CHILD_CSP).toContain("connect-src 'none';");
});

test("the appearance and reading preferences come before the first render, so the note's first paint is in them; nothing else does", () => {
  const before = (data: unknown) => checkParentMessage({ data, source: {}, activeSession: null });
  const session = "session-accepted";
  expect(before({ kind: "appearance", session, theme: "supabase-green", scheme: "light" }).ok).toBe(true);
  expect(before({ kind: "reading-preferences", session, preferences: { width: "standard", textSize: "default", wideMedia: false, wideTables: false }, bottomInset: 0 }).ok).toBe(true);
  // Still bounded, and still only on the frame's port.
  expect(before({ kind: "appearance", session, theme: "url(https://example.com)", scheme: "light" }).ok).toBe(false);
  expect(checkParentMessage({ data: { kind: "appearance", session, theme: "supabase-green", scheme: "light" }, source: null, activeSession: null }).ok).toBe(false);
  // Anything with the note's content or pixels waits for a render.
  for (const data of [
    { kind: "authoring-paths", session, paths: ["a.excalidraw"] },
    { kind: "comments", session, revision: 0, canComment: false, marks: [] },
    { kind: "resources", session, revision: 0, resources: [] },
    { kind: "images", session, revision: 0, reset: true, images: [] },
    { kind: "edit-settled", session, revision: 0, target: { from: 0, to: 1 }, outcome: "noop" },
    { kind: "render-ack", session, revision: 1, slots: [], fluid: { epoch: 0, operation: 1, runtimeKey: "k", islands: [] } },
  ]) expect(before(data).ok).toBe(false);
});
