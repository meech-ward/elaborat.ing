import type { DocumentSnapshot } from "../document";
import { getComponentDefinition, COMPONENT_CATALOG, type ComponentDefinition } from "../document/componentCatalog";
import type { StructuralResult } from "../document/structural";
import { isAllowedWorkspacePath } from "../workspace";
import type { BlockBoundary } from "./blocks";
import { encodePropLiteral } from "./protocol";

const ordinary: Record<string, string> = {
  Paragraph: "",
  Heading: "## ",
  "Bullet list": "- ",
  Quote: "> ",
  Divider: "---",
};

export function insertBlock(
  document: DocumentSnapshot,
  revision: number,
  boundaries: readonly BlockBoundary[],
  request: { boundary: string; element: string; path?: string },
  availablePaths: readonly string[],
  catalog: readonly ComponentDefinition[] = COMPONENT_CATALOG,
): StructuralResult {
  if (revision !== document.revision)
    throw new Error("Rejected stale block insertion.");
  const boundary = boundaries.find((entry) => entry.id === request.boundary);
  if (!boundary)
    throw new Error("Rejected insertion outside a parsed block boundary.");
  let content = Object.hasOwn(ordinary, request.element)
    ? ordinary[request.element]
    : undefined;
  if (content == null) {
    if (document.format !== "mdx")
      throw new Error("Components can only be inserted in MDX.");
    const definition = getComponentDefinition(request.element, catalog);
    if (!definition) throw new Error("Unknown component.");
    content = definition.template;
    if (request.element === "Drawing" || request.element === "Diagram") {
      const path = request.path ?? "";
      const correctKind =
        request.element === "Drawing"
          ? /\.excalidraw(?:\.md)?$/.test(path)
          : /\.d2$/.test(path);
      if (
        !availablePaths.includes(path) ||
        !isAllowedWorkspacePath(path) ||
        !correctKind
      )
        throw new Error("Choose an existing allowed workspace resource.");
      // Concrete catalog template owns syntax; only a validated literal path varies.
      content = content.replace(
        /src="[^"]*"/,
        () => `src=${encodePropLiteral("quoted-double", "string", path)}`,
      );
    }
  }
  const from = boundary.offset;
  const leading = from === 0 ? "" : "\n\n";
  const trailing = "\n\n";
  const insert = leading + content + trailing;
  const focus =
    from +
    leading.length +
    content.length +
    (["Paragraph", "Heading", "Bullet list", "Quote"].includes(request.element)
      ? 0
      : trailing.length);
  return { patch: { from, to: from, expected: "", insert }, focus };
}
