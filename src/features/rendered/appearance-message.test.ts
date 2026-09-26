import { expect, test } from "bun:test";
import { checkParentMessage, PREVIEW_CHILD_CSP } from "./protocol";
test("appearance is bounded presentation input bound to the established frame session", () => {
  const data = {
    kind: "appearance",
    session: "session-accepted",
    theme: "paper",
    scheme: "light",
  };
  const check = (
    value: unknown,
    activeSession: string | null = "session-accepted",
    source: unknown = {},
  ) => checkParentMessage({ data: value, source, activeSession });
  expect(check(data).ok).toBe(true);
  expect(check(data, null).ok).toBe(false);
  expect(check(data, "session-other").ok).toBe(false);
  expect(check(data, "session-accepted", null).ok).toBe(false);
  expect(check({ ...data, theme: "url(https://example.com)" }).ok).toBe(false);
  expect(check({ ...data, scheme: "system" }).ok).toBe(false);
  expect(PREVIEW_CHILD_CSP).toContain("font-src data:;");
  expect(PREVIEW_CHILD_CSP).toContain("connect-src 'none';");
});
