import { describe, expect, test } from "bun:test";
import { resolveMandatorySelection } from "./ViewSwitcher";

describe("resolveMandatorySelection", () => {
  test("keeps the current mode when the group change leaves nothing pressed", () => {
    expect(resolveMandatorySelection("source", [])).toBe("source");
  });
  test("adopts the newly pressed mode", () => {
    expect(resolveMandatorySelection("source", ["rendered"])).toBe("rendered");
  });
});
