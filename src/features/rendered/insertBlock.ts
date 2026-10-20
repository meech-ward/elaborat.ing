import type { DocumentSnapshot } from "../document";
import { getComponentDefinition, COMPONENT_CATALOG, type ComponentDefinition } from "../document/componentCatalog";
import type { StructuralResult } from "../document/structural";
import { isAllowedWorkspacePath } from "../workspace";
import type { BlockBoundary } from "./blocks";
import { encodePropLiteral } from "./protocol";
import { imageMarkdown, relativeImagePath, safeImagePath } from '../images/paths';
import { imageFigureMarkdown } from '../images/captions';

const ordinary: Record<string, string> = {
  Paragraph: "",
  Heading: "## ",
  "Bullet list": "- ",
  Quote: "> ",
  Divider: "---",
};

/** Trusted picker output at a parser-owned boundary; one source patch for all chosen images. */
export function insertImages(
  document: DocumentSnapshot,
  revision: number,
  boundaries: readonly BlockBoundary[],
  boundaryId: string,
  notePath: string,
  images: readonly {path:string;alt:string;caption?:string}[],
): StructuralResult {
  if (revision !== document.revision) throw new Error('Rejected stale image insertion.');
  const boundary = boundaries.find(entry => entry.id === boundaryId);
  if (!boundary) throw new Error('Choose a current document position for the image.');
  if (!images.length || images.length > 8 || images.some(image => !safeImagePath(image.path))) throw new Error('Choose up to eight project images.');
  const content = images.map(image => image.caption?.trim() ? imageFigureMarkdown(relativeImagePath(notePath,image.path),image.alt,image.caption.trim(),document.format) : imageMarkdown(relativeImagePath(notePath,image.path),image.alt,document.format)).join('\n\n');
  const newline = /\r\n|\n|\r/.exec(document.text)?.[0] ?? '\n';
  const leading = boundary.offset === 0 ? '' : newline + newline;
  const insert = leading + content.replace(/\r\n|\r|\n/g,newline) + newline + newline;
  return {patch:{from:boundary.offset,to:boundary.offset,expected:'',insert},focus:boundary.offset + insert.length};
}

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
  const newline = /\r\n|\n|\r/.exec(document.text)?.[0] ?? '\n';
  content = content.replace(/\r\n|\r|\n/g,newline);
  const leading = from === 0 ? "" : newline + newline;
  const trailing = newline + newline;
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
