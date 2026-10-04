import { expect, test } from "bun:test";
import { sandboxFrameUrl } from "./sandboxFrame";

test("the frame's page is the build's folder on the sandbox origin", () => {
  expect(sandboxFrameUrl("https://usercontent.test", "frame/0123456789abcdef/")).toBe("https://usercontent.test/frame/0123456789abcdef/");
  expect(sandboxFrameUrl("http://127.0.0.1:4175/", "frame/0123456789abcdef/")).toBe("http://127.0.0.1:4175/frame/0123456789abcdef/");
});

test("anything but an http(s) origin keeps the srcdoc frame", () => {
  for (const origin of [undefined, null, "", "usercontent.test", "https://usercontent.test/path", "javascript:alert(1)", "data:text/html,x", "https://user@usercontent.test"]) {
    expect(sandboxFrameUrl(origin, "frame/0123456789abcdef/")).toBeNull();
  }
});
