/**
 * Reads `path` and `content` out of a function call's arguments while they
 * stream in as raw JSON pieces, so a file can draw in as it is written. It
 * reads each character once: string escapes (also a \u escape cut between
 * two pieces), any key order, and values of other keys skipped. `content` is
 * the text so far, and `done` says whether its closing quote has come.
 */
export type ArgumentReader = {
  push(delta: string): void
  readonly path: string | null
  readonly content: string | null
  readonly pathDone: boolean
  readonly contentDone: boolean
}

type Mode = "start" | "key" | "colon" | "value" | "string" | "skip" | "after" | "end"

const ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" }
const isSpace = (char: string) => char === " " || char === "\n" || char === "\r" || char === "\t"

export function argumentReader(): ArgumentReader {
  let mode: Mode = "start"
  /** Inside a string: whether it is a key, and the key a value string belongs to. */
  let stringIsKey = false
  let key = ""
  let text = ""
  let escape: string | null = null
  // Skipping a value that is not a string: its depth, and whether inside a string in it.
  let depth = 0
  let skipString = false
  let skipEscape = false
  const values: Record<string, string> = {}
  const done = new Set<string>()

  const endString = () => {
    if (stringIsKey) {
      key = text
      mode = "colon"
    } else {
      values[key] = text
      done.add(key)
      mode = "after"
    }
    text = ""
  }

  const read = (char: string) => {
    switch (mode) {
      case "start":
        if (char === "{") mode = "key"
        return
      case "key":
        if (char === '"') {
          stringIsKey = true
          text = ""
          mode = "string"
        } else if (char === "}") mode = "end"
        return
      case "colon":
        if (char === ":") mode = "value"
        return
      case "value":
        if (isSpace(char)) return
        if (char === '"') {
          stringIsKey = false
          text = ""
          values[key] = ""
          mode = "string"
          return
        }
        mode = "skip"
        depth = 0
        skipString = false
        skipEscape = false
        read(char)
        return
      case "skip":
        if (skipString) {
          if (skipEscape) skipEscape = false
          else if (char === "\\") skipEscape = true
          else if (char === '"') skipString = false
          return
        }
        if (char === '"') skipString = true
        else if (char === "{" || char === "[") depth++
        else if ((char === "}" || char === "]") && depth > 0) depth--
        else if (depth === 0 && (char === "," || char === "}")) {
          mode = char === "," ? "key" : "end"
        }
        return
      case "after":
        if (char === ",") mode = "key"
        else if (char === "}") mode = "end"
        return
      case "string":
        if (escape !== null) {
          escape += char
          if (escape[0] === "u") {
            if (escape.length < 5) return
            const code = Number.parseInt(escape.slice(1), 16)
            text += Number.isNaN(code) ? "" : String.fromCharCode(code)
          } else text += ESCAPES[escape] ?? escape
          escape = null
        } else if (char === "\\") escape = ""
        else if (char === '"') return endString()
        else text += char
        if (!stringIsKey) values[key] = text
        return
      case "end":
        return
    }
  }

  const value = (name: string) => {
    const found = values[name]
    if (found === undefined) return null
    // A surrogate pair's first half waits for its second.
    const last = found.charCodeAt(found.length - 1)
    return !done.has(name) && last >= 0xd800 && last <= 0xdbff ? found.slice(0, -1) : found
  }

  return {
    push(delta) {
      for (let index = 0; index < delta.length; index++) {
        // Plain text inside a string is taken in one piece, up to a quote or a backslash.
        if (mode === "string" && escape === null) {
          let stop = index
          while (stop < delta.length && delta[stop] !== '"' && delta[stop] !== "\\") stop++
          if (stop > index) {
            text += delta.slice(index, stop)
            if (!stringIsKey) values[key] = text
            index = stop - 1
            continue
          }
        }
        read(delta[index])
      }
    },
    get path() {
      return value("path")
    },
    get content() {
      return value("content")
    },
    get pathDone() {
      return done.has("path")
    },
    get contentDone() {
      return done.has("content")
    },
  }
}
