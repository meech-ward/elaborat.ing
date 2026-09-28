import { useState, useSyncExternalStore, type RefObject } from "react";
import {
  CanvasIsland,
  MoreTools,
  ToolButton,
  ToolGroup,
  ZoomControl,
  canvasTools,
  commandShortcut,
  isApplePlatform,
  islandTools,
  type CanvasTool,
  type IslandSize,
  type MenuEntry,
} from "@/features/design-system";
import { MAX_ZOOM, MIN_ZOOM, ZOOM_STEP, islandTool, nativeTool, type CanvasUiStore } from "./canvasView";

/** What the controls ask of the canvas (DrawingCanvas drives Excalidraw with them). */
export interface CanvasCommands {
  /** Picks a tool by Excalidraw's name for it. */
  pickTool: (tool: string) => void;
  toggleLock: () => void;
  undo: () => void;
  redo: () => void;
  /** Whether undo and redo have anything to do now. */
  history: () => { undo: boolean; redo: boolean };
  toggleLibrary: () => void;
  openMermaid: () => void;
  zoomTo: (zoom: number) => void;
  /** Excalidraw's own element, which takes the keyboard for its shortcuts. */
  canvas: () => HTMLElement | null;
}

// Excalidraw's tools that have no island button: the extra tools.
const extraTools: readonly { id: string; label: string; shortcut?: string; group: string }[] = [
  { id: "frame", label: "Frame", shortcut: "F", group: "extra" },
  { id: "embeddable", label: "Web embed", group: "extra" },
  { id: "laser", label: "Laser pointer", shortcut: "K", group: "extra" },
];


/**
 * The canvas's own controls, from the design system: the tool island (at
 * the top centre of the canvas area on a desktop, at the bottom centre on
 * a phone), with More tools for the rest of Excalidraw's tools, tool lock,
 * the library and undo and redo, and the zoom island at the bottom left on
 * a desktop. They float over the part of the canvas a person can see (the
 * area's place comes from the page, see workbench.css) and drive
 * Excalidraw through its API; its own toolbar and footer stay hidden.
 */
export function CanvasControls({
  store,
  commands,
  areaRef,
  size,
  viewOnly,
  comment = null,
}: {
  store: CanvasUiStore;
  commands: CanvasCommands;
  /** The area element, which the canvas reads to fit and zoom the scene. */
  areaRef: RefObject<HTMLDivElement | null>;
  size: IslandSize;
  viewOnly: boolean;
  /** Comment on the one selected element, first in More tools; null where comments cannot be written. */
  comment?: { shortcut: { label: string; aria: string }; onComment: () => void } | null;
}) {
  const ui = useSyncExternalStore(store.subscribe, store.get, store.get);
  // Read when More tools opens: undo and redo are Excalidraw's own state.
  const [history, setHistory] = useState({ undo: false, redo: false });
  const apple = isApplePlatform();
  const shown = islandTools[size];
  // Read here, not when this module loads: the design system's style guide
  // imports this feature, so its exports can still be loading then.
  const more = (Object.values(canvasTools) as CanvasTool[]).filter((tool) => !shown.includes(tool));
  const current = islandTool(ui.tool);
  const pick = (tool: string) => commands.pickTool(nativeTool(tool));
  // Where the keyboard goes once More tools closes: the canvas after a tool
  // (for its keys), nowhere after the library or a dialog (they take it),
  // and back to More tools otherwise.
  const [after, focusAfter] = useState<"canvas" | "stay" | null>(null);
  const undoKey = commandShortcut("Z", apple);
  const redoKey = apple ? { label: "⌘⇧Z", aria: "Meta+Shift+Z" } : { label: "Ctrl+Shift+Z", aria: "Control+Shift+Z" };
  const entries: MenuEntry[] = [
    ...(comment
      ? [
          {
            label: "Comment",
            shortcut: comment.shortcut.label,
            keyShortcuts: comment.shortcut.aria,
            group: "comment",
            // It comments on one element: select one first.
            disabled: ui.single === null,
            onSelect: () => {
              // The new comment's field takes the keyboard.
              focusAfter("stay");
              comment.onComment();
            },
          },
        ]
      : []),
    ...[...more.map((tool) => ({ ...tool, group: "tools" })), ...extraTools].map((tool) => ({
      label: tool.label,
      shortcut: tool.shortcut,
      group: tool.group,
      onSelect: () => {
        focusAfter("canvas");
        pick(tool.id);
      },
    })),
    {
      label: "Mermaid to Excalidraw",
      group: "extra",
      onSelect: () => {
        focusAfter("stay");
        commands.openMermaid();
      },
    },
    {
      label: "Keep tool active",
      shortcut: "Q",
      group: "lock",
      checked: ui.locked,
      onSelect: () => {
        focusAfter("canvas");
        commands.toggleLock();
      },
    },
    {
      label: "Library",
      group: "library",
      onSelect: () => {
        focusAfter("stay");
        commands.toggleLibrary();
      },
    },
    { label: "Undo", shortcut: undoKey.label, keyShortcuts: undoKey.aria, group: "history", disabled: !history.undo, onSelect: commands.undo },
    { label: "Redo", shortcut: redoKey.label, keyShortcuts: redoKey.aria, group: "history", disabled: !history.redo, onSelect: commands.redo },
  ];
  const finalFocus = () => (after === "canvas" ? (commands.canvas() ?? true) : after !== "stay");
  const inMore = more.some((tool) => tool.id === current) || extraTools.some((tool) => tool.id === current);
  return (
    <div
      ref={areaRef}
      data-slot="canvas-controls"
      data-selection={ui.selected || undefined}
      className="pointer-events-none absolute top-[var(--canvas-area-top,0px)] right-0 bottom-0 left-[var(--canvas-area-left,0px)] z-[3]"
    >
      {!viewOnly && (
        <CanvasIsland
          size={size}
          className={
            size === "touch"
              ? "pointer-events-auto absolute bottom-[22px] left-1/2 -translate-x-1/2"
              : "pointer-events-auto absolute top-4 left-1/2 -translate-x-1/2"
          }
        >
          <ToolGroup value={current} onValueChange={pick} aria-label="Drawing tools">
            {shown.map((tool) => (
              <ToolButton key={tool.id} tool={tool} />
            ))}
          </ToolGroup>
          <MoreTools
            entries={entries}
            active={inMore}
            onOpenChange={(open) => {
              if (!open) return;
              setHistory(commands.history());
              focusAfter(null);
            }}
            contentProps={{ finalFocus }}
          />
        </CanvasIsland>
      )}
      {size === "default" && (
        <ZoomControl
          zoom={ui.zoom}
          onZoomOut={ui.zoom > MIN_ZOOM ? () => commands.zoomTo(ui.zoom - ZOOM_STEP) : undefined}
          onZoomIn={ui.zoom < MAX_ZOOM ? () => commands.zoomTo(ui.zoom + ZOOM_STEP) : undefined}
          onReset={() => commands.zoomTo(1)}
          className="pointer-events-auto absolute bottom-4 left-4"
        />
      )}
    </div>
  );
}
