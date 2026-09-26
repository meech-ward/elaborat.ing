import { describe, expect, test } from "bun:test"
import {
  anchorRange,
  describeRange,
  type TextPositionSelector,
  type TextQuoteSelector,
  type TextRange,
} from "./anchoring"

/** Describes before.slice(start, end), then finds that range in `after`. */
function reanchor(before: string, start: number, end: number, after: string): TextRange | null {
  const [quote, position] = describeRange(before, start, end)
  return anchorRange(after, quote, position)
}

const fox = "The quick brown fox jumps over the lazy dog."

describe("describeRange", () => {
  test("quotes the range with up to 32 code units of context on each side", () => {
    const text = "0123456789".repeat(10)
    expect(describeRange(text, 40, 45)).toEqual([
      {
        type: "TextQuoteSelector",
        exact: "01234",
        prefix: "89012345678901234567890123456789",
        suffix: "56789012345678901234567890123456",
      },
      { type: "TextPositionSelector", start: 40, end: 45 },
    ])
  })

  test("clips the context at the edges of the document", () => {
    expect(describeRange(fox, 4, 19)).toEqual([
      {
        type: "TextQuoteSelector",
        exact: "quick brown fox",
        prefix: "The ",
        suffix: " jumps over the lazy dog.",
      },
      { type: "TextPositionSelector", start: 4, end: 19 },
    ])
  })

  test("shortens context that would split a surrogate pair", () => {
    const emoji = "😀".repeat(20)
    // Emoji at 0-39, "quote" at 41-45, emoji at 47-86. Counting 32 code units
    // out from the quote lands inside an emoji on both sides.
    const [quote] = describeRange(`${emoji} quote ${emoji}`, 41, 46)
    expect(quote.prefix).toBe(`${"😀".repeat(15)} `)
    expect(quote.prefix).toHaveLength(31)
    expect(quote.suffix).toBe(` ${"😀".repeat(15)}`)
    expect(quote.suffix).toHaveLength(31)
  })

  test("keeps all 32 code units when the context ends between two emoji", () => {
    const emoji = "😀".repeat(20)
    const [quote] = describeRange(`${emoji}quote${emoji}`, 40, 45)
    expect(quote.prefix).toBe("😀".repeat(16))
    expect(quote.suffix).toBe("😀".repeat(16))
  })

  test("throws for an empty or out-of-bounds range", () => {
    expect(() => describeRange(fox, 4, 4)).toThrow(RangeError)
    expect(() => describeRange(fox, 19, 4)).toThrow(RangeError)
    expect(() => describeRange(fox, -1, 4)).toThrow(RangeError)
    expect(() => describeRange(fox, 40, 45)).toThrow(RangeError)
    expect(() => describeRange("", 0, 0)).toThrow(RangeError)
    expect(() => describeRange(fox, 0.5, 4)).toThrow(RangeError)
    expect(() => describeRange(fox, Number.NaN, 4)).toThrow(RangeError)
  })
})

describe("anchorRange", () => {
  test("unchanged text returns the original range", () => {
    expect(reanchor(fox, 4, 19, fox)).toEqual({ start: 4, end: 19 })

    // The second of three "one"s.
    const repeated = "one two one two one"
    expect(reanchor(repeated, 8, 11, repeated)).toEqual({ start: 8, end: 11 })
  })

  test("text inserted before the range shifts it", () => {
    const after = `A new first sentence. ${fox}`
    expect(reanchor(fox, 4, 19, after)).toEqual({ start: 26, end: 41 })
    expect(after.slice(26, 41)).toBe("quick brown fox")
  })

  test("text deleted before the range shifts it back, even past the end of the new text", () => {
    const before = `${"An introduction that gets cut. ".repeat(4)}Remember the milk.`
    const after = "Remember the milk."
    // The stored position, 124, is now beyond the end of the text.
    expect(before.slice(124, 132)).toBe("Remember")
    expect(reanchor(before, 124, 132, after)).toEqual({ start: 0, end: 8 })
  })

  test("text inserted inside the range returns the range around the edited quote", () => {
    const after = "The quick red brown fox jumps over the lazy dog."
    expect(reanchor(fox, 4, 19, after)).toEqual({ start: 4, end: 23 })
    expect(after.slice(4, 23)).toBe("quick red brown fox")
  })

  test("a quote longer than 32 characters with a few characters changed still anchors", () => {
    const before = "Intro. Comments shuold survive small edits to the qouted text. Outro."
    const after = "Intro. Comments should survive small edits to the quoted text. Outro."
    expect(before.slice(7, 62)).toBe("Comments shuold survive small edits to the qouted text.")
    expect(reanchor(before, 7, 62, after)).toEqual({ start: 7, end: 62 })
  })

  test("a quote anchors with up to half its characters changed, and no more", () => {
    const before = "Note: 0123456789 end."
    // Five of the ten characters changed.
    expect(reanchor(before, 6, 16, "Note: 01234abcde end.")).toEqual({ start: 6, end: 16 })
    // Six of the ten.
    expect(reanchor(before, 6, 16, "Note: 0123abcdef end.")).toBeNull()
  })

  test("a quote that appears twice picks the occurrence whose context matches", () => {
    // The first "hello" is now exactly at the stored position, but the second
    // one has the stored context.
    const after = "Cats say hello to everyone. Dogs say hello."
    expect(reanchor("Dogs say hello.", 9, 14, after)).toEqual({ start: 37, end: 42 })
    expect(after.slice(37, 42)).toBe("hello")
  })

  test("a quote whose text was deleted entirely returns null", () => {
    const first = "Comments stay attached as the text changes. "
    const last = "A comment whose text is gone shows as detached."
    const before = `${first}${fox} ${last}`
    expect(before.slice(44, 88)).toBe(fox)
    // What is left is longer than the quote, so the null comes from the
    // error limit, not from the text being too short.
    expect(reanchor(before, 44, 88, first + last)).toBeNull()
  })

  test("ranges at the very start and very end of the document", () => {
    const before = "Start here. Some middle text. End here."
    const after = "Start here. Some longer middle text. End here."

    expect(describeRange(before, 0, 5)[0].prefix).toBe("")
    expect(reanchor(before, 0, 5, after)).toEqual({ start: 0, end: 5 })

    expect(describeRange(before, 30, 39)[0].suffix).toBe("")
    expect(reanchor(before, 30, 39, after)).toEqual({ start: 37, end: 46 })
    expect(after.slice(37, 46)).toBe("End here.")

    expect(reanchor(before, 0, 39, before)).toEqual({ start: 0, end: 39 })

    // With no suffix, "fine", "finer" and "finer." are equally good matches.
    // The longest one is the edited quote.
    expect(reanchor("The last word is fine.", 17, 22, "The last word is finer.")).toEqual({
      start: 17,
      end: 23,
    })
    // Likewise at the start, where "Fxine", "xine" and "ine" are equally good.
    expect(reanchor("Fine words here.", 0, 4, "Fxine words here.")).toEqual({ start: 0, end: 5 })
  })

  test("text containing emoji before, inside and after the range", () => {
    // Each emoji is two UTF-16 code units.
    const before = "🎉 Launch day! The 🚀 ships at noon 🕛 sharp."
    expect(before.slice(15, 35)).toBe("The 🚀 ships at noon")

    expect(reanchor(before, 15, 35, before)).toEqual({ start: 15, end: 35 })

    const emojiBefore = "🎉🎉 Launch day! The 🚀 ships at noon 🕛 sharp."
    expect(reanchor(before, 15, 35, emojiBefore)).toEqual({ start: 17, end: 37 })

    const emojiReplacedInside = "🎉 Launch day! The 🛸 ships at noon 🕛 sharp."
    expect(reanchor(before, 15, 35, emojiReplacedInside)).toEqual({ start: 15, end: 35 })

    const emojiAddedInside = "🎉 Launch day! The 🚀🚀 ships at noon 🕛 sharp."
    expect(reanchor(before, 15, 35, emojiAddedInside)).toEqual({ start: 15, end: 37 })
    expect(emojiAddedInside.slice(15, 37)).toBe("The 🚀🚀 ships at noon")

    const emojiAfter = "🎉 Launch day! The 🚀 ships at noon 🕛🕛 sharp."
    expect(reanchor(before, 15, 35, emojiAfter)).toEqual({ start: 15, end: 35 })
  })

  test("returns null for an empty quote or empty text", () => {
    const quote: TextQuoteSelector = { type: "TextQuoteSelector", exact: "", prefix: "", suffix: "" }
    const position: TextPositionSelector = { type: "TextPositionSelector", start: 0, end: 0 }
    expect(anchorRange(fox, quote, position)).toBeNull()

    const [foxQuote, foxPosition] = describeRange(fox, 4, 19)
    expect(anchorRange("", foxQuote, foxPosition)).toBeNull()
  })

  test("the same inputs always return the same result", () => {
    // Both "cat"s score exactly the same: same quote, no stored context, and
    // the same distance from the stored position. The earlier one wins.
    const quote: TextQuoteSelector = { type: "TextQuoteSelector", exact: "cat", prefix: "", suffix: "" }
    const position: TextPositionSelector = { type: "TextPositionSelector", start: 5, end: 8 }
    for (let i = 0; i < 3; i++) {
      expect(anchorRange("cat, dog, cat", quote, position)).toEqual({ start: 0, end: 3 })
    }

    const after = "The quick red brown fox jumps over the lazy dog."
    for (let i = 0; i < 3; i++) {
      expect(describeRange(fox, 4, 19)).toEqual(describeRange(fox, 4, 19))
      expect(reanchor(fox, 4, 19, after)).toEqual({ start: 4, end: 23 })
    }
  })
})
