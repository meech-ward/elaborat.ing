// Describes a range of text with W3C Web Annotation selectors, and finds that
// range again after the text changes.
// https://www.w3.org/TR/annotation-model/#selectors
//
// Offsets are UTF-16 code units (JavaScript string indices), matching editor
// offsets. The W3C model counts code points instead.
//
// anchorRange ports matchQuote from Hypothesis's match-quote.ts,
// https://github.com/hypothesis/client/blob/main/src/annotator/anchoring/match-quote.ts
// Copyright (c) 2013-2019 Hypothes.is Project and contributors, used under the
// BSD 2-Clause license reproduced at the end of this file.

import search from "approx-string-match"

export type TextQuoteSelector = {
  type: "TextQuoteSelector"
  exact: string
  prefix: string
  suffix: string
}

export type TextPositionSelector = {
  type: "TextPositionSelector"
  start: number
  end: number
}

export type TextRange = { start: number; end: number }

/** Code units of context kept on each side of a quote. */
const CONTEXT_LENGTH = 32

// How much each part of a candidate's score counts, as in Hypothesis.
const QUOTE_WEIGHT = 50
const PREFIX_WEIGHT = 20
const SUFFIX_WEIGHT = 20
const POSITION_WEIGHT = 2
const TOTAL_WEIGHT = QUOTE_WEIGHT + PREFIX_WEIGHT + SUFFIX_WEIGHT + POSITION_WEIGHT

type Match = { start: number; end: number; errors: number }

type Candidate = TextRange & { score: number; distance: number }

/** Selectors for text.slice(start, end). Throws RangeError if start >= end or out of bounds. */
export function describeRange(
  text: string,
  start: number,
  end: number,
): [TextQuoteSelector, TextPositionSelector] {
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    start >= end ||
    end > text.length
  ) {
    throw new RangeError(`Cannot describe range ${start} to ${end} in text of length ${text.length}`)
  }

  let prefixStart = Math.max(0, start - CONTEXT_LENGTH)
  if (splitsSurrogatePair(text, prefixStart)) prefixStart += 1
  let suffixEnd = Math.min(text.length, end + CONTEXT_LENGTH)
  if (splitsSurrogatePair(text, suffixEnd)) suffixEnd -= 1

  return [
    {
      type: "TextQuoteSelector",
      exact: text.slice(start, end),
      prefix: text.slice(prefixStart, start),
      suffix: text.slice(end, suffixEnd),
    },
    { type: "TextPositionSelector", start, end },
  ]
}

/** The best match for the selectors in (possibly changed) text, or null. */
export function anchorRange(
  text: string,
  quote: TextQuoteSelector,
  position: TextPositionSelector,
): TextRange | null {
  const { exact, prefix, suffix } = quote
  if (exact.length === 0) return null

  // Allowing more errors finds more edited quotes, but also more wrong
  // candidates, and the search takes longer.
  const maxErrors = Math.min(256, Math.floor(exact.length / 2))

  let best: Candidate | null = null
  for (const match of findMatches(text, exact, maxErrors)) {
    const quoteScore = 1 - match.errors / exact.length
    const prefixScore =
      prefix === ""
        ? 1
        : similarity(text.slice(Math.max(0, match.start - prefix.length), match.start), prefix)
    const suffixScore =
      suffix === "" ? 1 : similarity(text.slice(match.end, match.end + suffix.length), suffix)
    const distance = Math.abs(match.start - position.start)
    const positionScore = 1 - distance / text.length

    const score =
      (QUOTE_WEIGHT * quoteScore +
        PREFIX_WEIGHT * prefixScore +
        SUFFIX_WEIGHT * suffixScore +
        POSITION_WEIGHT * positionScore) /
      TOTAL_WEIGHT
    const candidate = { start: match.start, end: match.end, score, distance }
    if (best === null || ranksHigher(candidate, best)) best = candidate
  }

  return best === null ? null : { start: best.start, end: best.end }
}

/**
 * Every exact occurrence of `pattern` in `text` or, only if there are none,
 * the approximate matches with the fewest errors, up to `maxErrors`.
 * `pattern` must not be empty.
 */
function findMatches(text: string, pattern: string, maxErrors: number): Match[] {
  const matches: Match[] = []
  for (let i = text.indexOf(pattern); i !== -1; i = text.indexOf(pattern, i + 1)) {
    matches.push({ start: i, end: i + pattern.length, errors: 0 })
  }
  return matches.length > 0 ? matches : search(text, pattern, maxErrors)
}

/**
 * How closely some part of `actual` matches `expected`, from 0 to 1, like
 * Hypothesis's textMatchScore.
 */
function similarity(actual: string, expected: string): number {
  if (actual.length === 0 || expected.length === 0) return 0
  // Allowing as many errors as `expected` has code units, a non-empty text
  // always has at least one match.
  const [closest] = findMatches(actual, expected, expected.length)
  return 1 - closest.errors / expected.length
}

/**
 * Whether `a` beats `b`: a higher score, then for exact ties the smaller
 * distance to the stored position, then the smaller start, then the larger
 * end. Approximate matches that share a start tie when there is no suffix to
 * tell them apart, at the end of the document. Taking the longest one matches
 * how approx-string-match picks among equally good starts.
 */
function ranksHigher(a: Candidate, b: Candidate): boolean {
  if (a.score !== b.score) return a.score > b.score
  if (a.distance !== b.distance) return a.distance < b.distance
  if (a.start !== b.start) return a.start < b.start
  return a.end > b.end
}

/** Whether `index` falls between the two halves of a surrogate pair. */
function splitsSurrogatePair(text: string, index: number): boolean {
  const before = text.charCodeAt(index - 1)
  const after = text.charCodeAt(index)
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
}

// Hypothesis license, for the parts of anchorRange ported from match-quote.ts:
//
// Copyright (c) 2013-2019 Hypothes.is Project and contributors
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
// 1. Redistributions of source code must retain the above copyright notice, this
//    list of conditions and the following disclaimer.
// 2. Redistributions in binary form must reproduce the above copyright notice,
//    this list of conditions and the following disclaimer in the documentation
//    and/or other materials provided with the distribution.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
// ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
// WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
// DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
// ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
// (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
// LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
// ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
// (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
// SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
