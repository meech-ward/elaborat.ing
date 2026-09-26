import { describe, expect, it } from "bun:test"
import { createD2MonarchLanguage, D2_LANGUAGE_ID } from "./d2Language"

describe("d2Language", () => {
  it("registers under the d2 id", () => {
    expect(D2_LANGUAGE_ID).toBe("d2")
  })

  it("covers the core layout keywords", () => {
    const language = createD2MonarchLanguage()
    for (const word of ["direction", "shape", "label", "style", "layers", "grid-rows"]) {
      expect(language.keywords).toContain(word)
    }
  })

  it("tokenizes comments, strings, arrows, shapes and numbers", () => {
    const language = createD2MonarchLanguage()
    const root = language.tokenizer.root as Array<[RegExp, string, string?]>
    const actionFor = (sample: string): string | null => {
      for (const [pattern, action] of root) {
        const match = pattern.exec(sample)
        if (match && match.index === 0) {
          return typeof action === "string" ? action : JSON.stringify(action)
        }
      }
      return null
    }
    expect(actionFor("# a comment")).toBe("comment")
    expect(actionFor('"a label"')).toBe("string")
    expect(actionFor("a -> b")).toContain("identifier")
    expect(actionFor("->")).toBe("operator")
    expect(actionFor("...@file")).toBe("operator")
    expect(actionFor("oval")).toBe("type")
    expect(actionFor("42")).toBe("number")
    expect(actionFor("{")).toBe("@brackets")
  })

  it("falls back to keyword/identifier for words", () => {
    const language = createD2MonarchLanguage()
    const root = language.tokenizer.root as Array<[RegExp, { cases: Record<string, string> }]>
    const wordRule = root.find(
      (rule) => rule[0].source.includes("a-zA-Z") && typeof rule[1] === "object",
    )
    expect(wordRule?.[1]).toEqual({ cases: { "@keywords": "keyword", "@default": "identifier" } })
  })

  it("marks unclosed strings invalid", () => {
    const language = createD2MonarchLanguage()
    const root = language.tokenizer.root as Array<[RegExp, string, string?]>
    const invalid = root.filter(([, action]) => action === "string.invalid")
    expect(invalid).toHaveLength(2)
  })

  it("keeps every transitioned state inside the tokenizer map", () => {
    // Regression: states placed beside `tokenizer` throw
    // "the next state ... is not defined" in the browser and take down the
    // route. Every @state referenced from root must exist in the map.
    const language = createD2MonarchLanguage()
    const states = language.tokenizer as Record<string, unknown>
    const refs = new Set<string>()
    const root = states["root"] as Array<[RegExp, string, string?]>
    for (const rule of root) {
      const next = rule[2]
      if (typeof next === "string" && next.startsWith("@") && next !== "@pop" && next !== "@push") {
        refs.add(next.slice(1))
      }
    }
    expect(refs.size).toBeGreaterThan(0)
    for (const name of refs) {
      expect(states[name], `tokenizer state @${name}`).toBeDefined()
    }
    // No stray states beside the map.
    for (const key of Object.keys(language)) {
      expect(["keywords", "tokenizer"]).toContain(key)
    }
  })
})
