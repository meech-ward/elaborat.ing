import { describe, expect, test } from "bun:test";
import { fluidRangeForSource, sourceRangeForFluid } from "./commentMarks";
import { projectFluidSource } from "./fluidProjection";

const NOTE = "# Plan\n\nThe **first** paragraph says hello.\n\n## Steps\n\nOne step.\n";
const span = (part: string) => [NOTE.indexOf(part), NOTE.indexOf(part) + part.length] as const;

describe("commented text between the source and the rendered note", () => {
  test("a source range marks the same words in the document, without the syntax around them", async () => {
    const projection = await projectFluidSource(NOTE, "md");
    const text = (range: { from: number; to: number } | null) => (range ? projection.doc.textBetween(range.from, range.to) : null);
    expect(text(fluidRangeForSource(projection, ...span("says hello")))).toBe("says hello");
    expect(text(fluidRangeForSource(projection, ...span("**first** paragraph")))).toBe("first paragraph");
    // A section's heading line marks the heading's words.
    expect(text(fluidRangeForSource(projection, ...span("## Steps")))).toBe("Steps");
    // Syntax alone has no rendered text.
    expect(fluidRangeForSource(projection, ...span("## "))).toBeNull();
  });

  test("a document selection maps back to the source it came from, and a caret to its offset", async () => {
    const projection = await projectFluidSource(NOTE, "md");
    // A selection from the start of bold words takes their opening `**` with them.
    const marked = fluidRangeForSource(projection, ...span("first** paragraph"))!;
    const back = sourceRangeForFluid(projection, marked.from, marked.to)!;
    expect(NOTE.slice(back.from, back.to)).toBe("**first** paragraph");
    const plain = fluidRangeForSource(projection, ...span("says hello"))!;
    const plainBack = sourceRangeForFluid(projection, plain.from, plain.to)!;
    expect(NOTE.slice(plainBack.from, plainBack.to)).toBe("says hello");
    const heading = fluidRangeForSource(projection, ...span("Steps"))!;
    expect(sourceRangeForFluid(projection, heading.from, heading.from)).toEqual({ from: NOTE.indexOf("Steps"), to: NOTE.indexOf("Steps") });
  });
});
