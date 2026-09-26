import type { languages } from "monaco-editor"

/**
 * Minimal Monarch language for D2 diagram sources.
 *
 * Monaco 0.56 ships no D2 grammar; this small definition covers comments,
 * strings, the core layout keywords, shape names, connection operators and
 * numbers so `.d2` files read as code instead of markdown or plain text.
 * Highlighting only: nothing here parses, compiles or validates D2 (that
 * is the D2 compiler's job). Deliberately narrow; unknown words
 * stay identifiers.
 */

export const D2_LANGUAGE_ID = "d2"

const KEYWORDS = [
  // Layout and containers.
  "direction",
  "shape",
  "label",
  "icon",
  "link",
  "tooltip",
  "width",
  "height",
  "top",
  "left",
  "near",
  "grid-rows",
  "grid-columns",
  "grid-gap",
  "vertical-gap",
  "horizontal-gap",
  // Style block keys.
  "style",
  "opacity",
  "stroke",
  "fill",
  "stroke-width",
  "stroke-dash",
  "border-radius",
  "shadow",
  "multiple",
  "double-border",
  "animated",
  "bold",
  "italic",
  "underline",
  "font-size",
  "font-color",
  "font",
  "mono-font",
  "text-transform",
  // Structure keywords.
  "classes",
  "vars",
  "layers",
  "scenarios",
  "steps",
  "null",
  "true",
  "false",
]

export const D2_SHAPES = [
  "rectangle",
  "square",
  "page",
  "parallelogram",
  "document",
  "cylinder",
  "queue",
  "package",
  "step",
  "callout",
  "stored_data",
  "person",
  "diamond",
  "oval",
  "circle",
  "hexagon",
  "cloud",
  "text",
  "code",
  "class",
  "sql_table",
  "image",
]

const shapePattern = new RegExp(`\\b(?:${D2_SHAPES.join("|")})\\b`)

/**
 * Build the Monarch grammar (factory so the shape rule stays in sync).
 *
 * All states live INSIDE `tokenizer`: Monaco resolves `@name` transitions
 * against that map only, and a state placed beside it throws
 * "the next state ... is not defined" at tokenize time (proven by browser
 * smoke: the throw escapes into the route error boundary).
 */
export function createD2MonarchLanguage(): languages.IMonarchLanguage {
  return {
    keywords: KEYWORDS,
    tokenizer: {
      root: [
        [/#.*$/, "comment"],
        // Unclosed strings get the invalid scope instead of swallowing the file.
        [/"([^"\\]|\\.)*$/, "string.invalid"],
        [/'([^'\\]|\\.)*$/, "string.invalid"],
        [/"/, "string", "@string_double"],
        [/'/, "string", "@string_single"],
        [/[{}[\]()]/, "@brackets"],
        [/<->|->|<-|--|\.\.\./, "operator"],
        [/\b\d+(\.\d+)?\b/, "number"],
        [shapePattern, "type"],
        [/[a-zA-Z_][\w-]*/, { cases: { "@keywords": "keyword", "@default": "identifier" } }],
        [/[;:|.,]/, "delimiter"],
      ],
      string_double: [
        [/[^\\"]+/, "string"],
        [/\\./, "string.escape"],
        [/"/, "string", "@pop"],
      ],
      string_single: [
        [/[^\\']+/, "string"],
        [/\\./, "string.escape"],
        [/'/, "string", "@pop"],
      ],
    },
  }
}
