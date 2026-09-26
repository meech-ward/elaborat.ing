import { describe, expect, test } from "bun:test";
import { buildNativeDownload, nativeDownloadFilename } from "./nativeDownload.ts";
import { serializeDrawing, type DrawingScene } from "@/features/drawings/index.ts";

function authoredScene(): DrawingScene {
  return {
    type: "excalidraw",
    version: 2,
    source: "https://excalidraw.com",
    elements: [
      {
        id: "rect-1",
        type: "rectangle",
        x: 10,
        y: 20,
        width: 100,
        height: 50,
        strokeColor: "#1e1e1e",
        backgroundColor: "transparent",
        customData: { authoredBy: "test-author" },
      },
      { id: "hello-1", type: "text", x: 12, y: 24, text: "hello unsaved" },
      { id: "arrow-loose-1", type: "arrow", x: 0, y: 0, points: [[0, 0], [40, 40]] },
    ],
    files: {
      "img-1": {
        mimeType: "image/png",
        id: "img-1",
        dataURL: "data:image/png;base64,AAA",
        created: 1,
      },
    },
    extra: { vendorMystery: { keep: true } },
  };
}

describe("nativeDownloadFilename", () => {
  test("derives the download name from the selected path", () => {
    expect(nativeDownloadFilename("drawings/note.excalidraw")).toBe("note.excalidraw");
    expect(nativeDownloadFilename("drawings/note.excalidraw.md")).toBe("note.excalidraw");
    expect(nativeDownloadFilename("notes/foo.md")).toBe("foo.excalidraw");
    expect(nativeDownloadFilename("")).toBe("drawing.excalidraw");
  });
});

describe("buildNativeDownload", () => {
  test("canvas view serializes the current unsaved scene with unknown fields intact", () => {
    const scene = authoredScene();
    const result = buildNativeDownload({
      view: "canvas",
      scene,
      sourceDraft: `{"type":"excalidraw","version":2,"elements":[]}`,
      path: "drawings/note.excalidraw.md",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.filename).toBe("note.excalidraw");
    const payload = JSON.parse(result.text) as Record<string, unknown>;
    expect(payload["type"]).toBe("excalidraw");
    const elements = payload["elements"] as Record<string, unknown>[];
    expect(elements.map((entry) => entry["id"])).toContain("arrow-loose-1");
    expect(elements.map((entry) => entry["id"])).toContain("hello-1");
    const rect = elements.find((entry) => entry["id"] === "rect-1");
    expect(rect?.["customData"]).toEqual({ authoredBy: "test-author" });
    expect(payload["vendorMystery"]).toEqual({ keep: true });
    expect(payload["files"]).toBeDefined();
  });

  test("source view exports the current draft, and an Obsidian wrapper becomes standard native JSON", () => {
    const scene = authoredScene();
    const wrapper =
      `# note\n\nmy drawing\n\n\`\`\`json\n${serializeDrawing(scene)}\n\`\`\`\n`;
    const result = buildNativeDownload({
      view: "source",
      scene: null,
      sourceDraft: wrapper,
      path: "drawings/note.excalidraw.md",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.filename).toBe("note.excalidraw");
    expect(result.text).not.toContain("```");
    expect(result.text).not.toContain("compressed-json");
    const payload = JSON.parse(result.text) as Record<string, unknown>;
    expect(payload["type"]).toBe("excalidraw");
    expect((payload["elements"] as unknown[]).length).toBe(3);
  });

  test("source view rejects invalid source instead of silently exporting the old scene", () => {
    const oldScene = authoredScene();
    const result = buildNativeDownload({
      view: "source",
      scene: oldScene,
      sourceDraft: "{ not valid json",
      path: "drawings/note.excalidraw",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.length).toBeGreaterThan(0);
  });

  test("canvas view with no scene reports instead of exporting", () => {
    const result = buildNativeDownload({
      view: "canvas",
      scene: null,
      sourceDraft: "",
      path: "drawings/note.excalidraw",
    });
    expect(result.ok).toBe(false);
  });
});
