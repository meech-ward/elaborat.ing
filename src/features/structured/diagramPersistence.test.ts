import { expect, test } from "bun:test";
import { diagramSidecarText } from "./diagramPersistence";
import { readSidecarFile, regenerateDiagram } from "./structuredClient";

test("a saved generated scene retains its full merge base even without overrides", async () => {
  const diagram = (label: string) => ({
    shapes: [{ id: "a", type: "rectangle", pos: { x: 0, y: 0 }, width: 100, height: 50, label, labelWidth: 40, labelHeight: 20 }],
    connections: [],
  });
  const first = await regenerateDiagram(diagram("Before"), null, { source: "a: Before", prior: null, baseScene: null });
  const diskSidecar = diagramSidecarText(first.baseline, first.scene);
  expect(diskSidecar).not.toBeNull();
  const persisted = readSidecarFile(diskSidecar);
  expect(persisted?.overrides).toEqual({});
  expect(persisted?.baseline).toEqual(first.baseline);
  const reopened = await regenerateDiagram(diagram("After"), null, {
    source: "a: After",
    prior: { baseline: persisted?.baseline ?? null, scene: first.scene },
    baseScene: first.scene,
  });
  expect(reopened.conflicts).toEqual([]);
  expect(reopened.scene.elements.find((el) => el.id === "d2:a:label")?.text).toBe("After");
  const nextSidecar = readSidecarFile(diagramSidecarText(reopened.baseline, reopened.scene));
  expect(nextSidecar?.baseline).toEqual(reopened.baseline);
  expect(nextSidecar?.sourceHash).not.toBe(persisted?.sourceHash);
  expect(nextSidecar?.overrides).toEqual({});
});
