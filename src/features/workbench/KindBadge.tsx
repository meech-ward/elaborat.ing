import { kindForPath } from "./session";

const LETTERS = { note: "M", drawing: "D", diagram: "2", text: "" } as const;

/**
 * A file's kind as one letter in its kind colour: "M" for notes (.md and
 * .mdx), "D" for drawings, "2" for D2 diagrams, and an empty slot for other
 * files so names line up. Decoration only: the name says the same.
 */
export function KindBadge({ path }: { path: string }) {
  const kind = kindForPath(path);
  return (
    <span aria-hidden="true" className="wb-kind" data-kind={kind}>
      {LETTERS[kind]}
    </span>
  );
}
