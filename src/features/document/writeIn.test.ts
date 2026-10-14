import { describe, expect, test } from "bun:test";
import { appendedFrom } from "./writeIn";

describe("appendedFrom", () => {
  test("finds where text added on new lines starts, as append_to_note adds it", () => {
    const after = "# Plan\n\nFirst.\n\n## Next\n";
    expect(appendedFrom("# Plan\n\nFirst.\n", after)).toBe(after.indexOf("## Next"));
    // The whitespace the note ended with may have gone.
    expect(appendedFrom("# Plan\n\nFirst.  \n\n\n", after)).toBe(after.indexOf("## Next"));
    expect(appendedFrom("# Plan\n\nFirst.", after)).toBe(after.indexOf("## Next"));
    // An empty note gains all of it.
    expect(appendedFrom("", "## Next\n")).toBe(0);
    expect(appendedFrom("\n", "\n\n## Next\n")).toBe(2);
  });

  test("is null for any other change", () => {
    const before = "# Plan\n\nFirst.\n";
    expect(appendedFrom(before, "# Plan\n\nFirst!\n\n## Next\n")).toBeNull();
    expect(appendedFrom(before, "# Plan\n\nFirst. And more.\n")).toBeNull();
    expect(appendedFrom(before, "# Plan\n\nFirst.\n\n\n")).toBeNull();
    expect(appendedFrom(before, before)).toBeNull();
    expect(appendedFrom(before, "# Plan\n")).toBeNull();
  });
});
