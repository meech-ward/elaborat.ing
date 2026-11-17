import { describe, expect, test } from "bun:test";
import { parseReviewBundle, serializeReviewBundle, type PortableReviewBundle } from "./portable";
import { acceptReviewSuggestion, applyReviewPatches, proposedSource, rejectReviewSuggestion } from "./review";
import { MAX_REVIEW_ANNOTATIONS, MAX_REVIEW_DRAFT_BYTES, MAX_REVIEW_SOURCE_BYTES } from "./validation";

export function importedBundle(): PortableReviewBundle {
  return {
    format: "elaborating-review", version: 1, path: "notes/example.mdx",
    base: "# 😀\r\n\r\nalpha middle omega\r\n",
    suggestions: [
      { id: "first", from: 8, to: 13, expected: "alpha", insert: "ALPHA", sourceIds: ["change:1"] },
      { id: "last", from: 21, to: 26, expected: "omega", insert: "OMEGA", sourceIds: ["change:2"] },
    ],
    provenance: {
      label: "Imported document", sourceSha256: "a".repeat(64),
      base: "# 😀\r\n\r\nalpha middle omega\r\n",
      proposed: "# 😀\r\n\r\nALPHA middle OMEGA\r\n",
      annotations: [
        { id: "change:1", sourceId: "1", kind: "insertion", author: "Document author", date: "2026-11-17T09:00:00Z", rawXml: "<w:ins w:id=\"1\">ALPHA</w:ins>", locator: "word/document.xml/p[1]", anchor: { projection: "docx-review", from: 0, to: 5, quote: "ALPHA" } },
        { id: "change:2", sourceId: "2", kind: "replacement", author: "Another author", date: "2026-11-17T10:00:00Z", text: "Replace omega" },
        { id: "comment:1", sourceId: "1", kind: "comment", author: "Reviewer", text: "A comment on inserted text", anchor: { projection: "proposed", from: 8, to: 13, quote: "ALPHA" } },
        { id: "format:1", sourceId: "3", kind: "formatting", rawXml: "<w:rPrChange w:id=\"3\"/>" },
      ],
    },
  };
}

describe("portable local review bundles", () => {
  test("round trips exact MDX, pending source hunks and all imported source metadata without device credentials", () => {
    const bundle = importedBundle();
    const raw = serializeReviewBundle(bundle.path, { ...bundle, baseRevision: "private-revision", token: "private-token", scope: "private-account" } as typeof bundle);
    expect(raw).not.toContain("private-");
    const restored = parseReviewBundle(raw);
    expect(restored).toEqual(bundle);
    expect(proposedSource(restored)).toBe(bundle.provenance!.proposed!);
    expect(restored.base).toBe(bundle.provenance!.base!);
  });

  test("partial acceptance rebases remaining patches while retaining original annotation coordinates and XML", () => {
    const bundle = importedBundle();
    const accepted = acceptReviewSuggestion(bundle, "first");
    expect(accepted.base).toBe(bundle.base.replace("alpha", "ALPHA"));
    expect(proposedSource(accepted)).toBe(bundle.provenance!.proposed!);
    expect(accepted.provenance).toEqual(bundle.provenance);
    const rejected = rejectReviewSuggestion(accepted, "last");
    expect(rejected.suggestions).toEqual([]);
    const recovered = parseReviewBundle(serializeReviewBundle(bundle.path, rejected));
    expect(recovered.provenance).toEqual(bundle.provenance);
    expect(recovered.base).toBe(accepted.base);
  });

  test("editing across imported hunks unions their source identities and labels the local modification", () => {
    const bundle = importedBundle();
    const changed = applyReviewPatches(bundle, [{ from: 8, to: 26, expected: "ALPHA middle OMEGA", insert: "replacement" }]);
    expect(changed.suggestions).toHaveLength(1);
    expect(changed.suggestions[0]).toMatchObject({ sourceIds: ["change:1", "change:2"], edited: true });
    expect(changed.provenance).toEqual(bundle.provenance);
    expect(proposedSource(changed)).toBe(bundle.base.replace("alpha middle omega", "replacement"));
  });

  test("rejects unknown versions, identities and metadata instead of dropping information", () => {
    const bundle = importedBundle();
    for (const invalid of [
      { ...bundle, version: 2 }, { ...bundle, token: "device-token" }, { ...bundle, baseRevision: "device-revision" },
      { ...bundle, path: "../other.mdx" }, { ...bundle, path: "image.png" },
      { ...bundle, provenance: { ...bundle.provenance, unexpected: "metadata" } },
      { ...bundle, suggestions: [{ ...bundle.suggestions[0], unknownAuthor: "not preserved" }] },
    ]) expect(() => parseReviewBundle(JSON.stringify(invalid))).toThrow();
    expect(() => parseReviewBundle("not JSON")).toThrow("not a valid review bundle");
  });

  test("rejects stale source, duplicate references and invalid immutable anchors", () => {
    const bundle = importedBundle();
    for (const invalid of [
      { ...bundle, suggestions: [{ ...bundle.suggestions[0], expected: "wrong" }] },
      { ...bundle, suggestions: [{ ...bundle.suggestions[0], sourceIds: ["absent"] }] },
      { ...bundle, suggestions: [{ ...bundle.suggestions[0], sourceIds: ["change:1", "change:1"] }] },
      { ...bundle, provenance: { ...bundle.provenance, annotations: [bundle.provenance!.annotations[0], bundle.provenance!.annotations[0]] } },
      { ...bundle, provenance: { ...bundle.provenance, proposed: "different source" } },
      { ...bundle, provenance: { ...bundle.provenance, proposed: undefined } },
      { ...bundle, provenance: { ...bundle.provenance, annotations: [{ id: "bad", kind: "comment", anchor: { projection: "docx-review", from: 10, to: 1 } }] }, suggestions: [] },
    ]) expect(() => parseReviewBundle(JSON.stringify(invalid))).toThrow();
  });

  test("bounds untrusted metadata and UTF-8 payloads before making review state", () => {
    const bundle = importedBundle();
    expect(() => parseReviewBundle(" ".repeat(MAX_REVIEW_DRAFT_BYTES + 1))).toThrow("larger than 4 MiB");
    expect(() => parseReviewBundle(JSON.stringify({ ...bundle, base: "é".repeat(MAX_REVIEW_SOURCE_BYTES / 2 + 1), suggestions: [] }))).toThrow();
    expect(() => parseReviewBundle(JSON.stringify({ ...bundle, provenance: { ...bundle.provenance, annotations: [{ id: "xml", kind: "formatting", rawXml: "x".repeat(128 * 1024 + 1) }] }, suggestions: [] }))).toThrow();
    expect(() => parseReviewBundle(JSON.stringify({ ...bundle, provenance: { ...bundle.provenance, annotations: Array.from({ length: MAX_REVIEW_ANNOTATIONS + 1 }, (_, i) => ({ id: String(i), kind: "comment" })) } }))).toThrow();
  });
});
