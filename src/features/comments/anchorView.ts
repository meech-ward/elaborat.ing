import type { CommentAnchorView } from "@/features/design-system"
import type { ThreadPlace } from "./controller"
import type { CommentAnchor } from "./placement"

/**
 * A thread's context line, from its stored anchor and where the file on
 * screen found it (`place`, from `CommentsController.placesFor`). Without a
 * place, the stored quote is shown as it is. A detached thread shows the
 * quote it was made on.
 */
export function anchorView(anchor: CommentAnchor, place?: ThreadPlace): CommentAnchorView {
  const detached = place?.attached === false
  switch (anchor.kind) {
    case "document":
      return { kind: "document" }
    case "element":
      return detached ? { kind: "element", label: elementName(anchor.label), detached } : { kind: "element", label: elementName(place?.text ?? anchor.label) }
    case "text":
      return detached ? { kind: "text", quote: anchor.quote.exact, detached } : { kind: "text", quote: place?.text ?? anchor.quote.exact }
    case "section":
      return detached
        ? { kind: "section", heading: headingWords(anchor.quote.exact), detached }
        : { kind: "section", heading: headingWords(place?.text ?? anchor.quote.exact) }
  }
}

/** A heading line's words: `## Setup ##` and a setext heading's text line both give "Setup". */
export function headingWords(line: string): string {
  const atx = /^ {0,3}#{1,6}(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(line)
  return (atx ? (atx[1] ?? "") : line).trim()
}

// What an element with no text of its own is called on screen, by the type
// its label keeps.
const ELEMENT_NAMES: Record<string, string> = {
  rectangle: "Rectangle",
  diamond: "Diamond",
  ellipse: "Ellipse",
  arrow: "Arrow",
  line: "Line",
  freedraw: "Freehand drawing",
  text: "Text",
  image: "Image",
  frame: "Frame",
  magicframe: "Frame",
  embeddable: "Web embed",
  iframe: "Web embed",
  element: "Element",
}

/**
 * An element label as the panel and the pins show it: a label that is only
 * the element's type (an element with no text) reads as its name,
 * "rectangle" as "Rectangle". Other labels show as they are.
 */
export function elementName(label: string): string {
  return Object.hasOwn(ELEMENT_NAMES, label) ? ELEMENT_NAMES[label] : label
}
