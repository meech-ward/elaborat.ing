import { expect, test } from "bun:test";
import { canvasViewFrom } from "./canvasViews";

test("a remembered view opens as a drawing's or diagram's view", () => {
  expect(canvasViewFrom("split")).toBe("split");
  expect(canvasViewFrom("source")).toBe("source");
  // A diagram's earlier "Code" view is now its Source.
  expect(canvasViewFrom("code")).toBe("source");
  expect(canvasViewFrom("canvas")).toBe("canvas");
  expect(canvasViewFrom("rendered")).toBe("canvas");
  expect(canvasViewFrom(null)).toBe("canvas");
});
