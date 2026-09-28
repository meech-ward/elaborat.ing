import { useEffect, useSyncExternalStore, type RefObject } from "react";
import { CommentMarker } from "@/features/design-system";
import type { CanvasPin } from "@/features/comments";
import { pinScenePoint, sceneToCanvas, type CanvasUiStore, type CanvasViewport, type ElementGeometry } from "./canvasView";

// Comments on a drawing's elements, over the canvas: the library's pins,
// each at its element's spot, and Comment in Excalidraw's own menu for an
// element. The pins' places are worked out on every change the canvas
// reports (a pan, a zoom, an element moving) and only redraw when one moved.

/** A pin's place on screen: its point, relative to the canvas's top left. */
export type PinPlace = { left: number; top: number };

/** An element as the pins read it. */
export type PinElement = ElementGeometry & { id: string; isDeleted?: boolean };

const NO_PLACES: ReadonlyMap<string, PinPlace> = new Map();

/** Where each pin is on screen, by pin id; pins whose element is gone have none. */
export function pinPlaces(pins: readonly CanvasPin[], elements: readonly PinElement[], view: CanvasViewport): ReadonlyMap<string, PinPlace> {
  if (pins.length === 0) return NO_PLACES;
  const wanted = new Set(pins.map((pin) => pin.elementId));
  const live = new Map<string, PinElement>();
  for (const element of elements) if (!element.isDeleted && wanted.has(element.id)) live.set(element.id, element);
  const places = new Map<string, PinPlace>();
  for (const pin of pins) {
    const element = live.get(pin.elementId);
    if (!element) continue;
    const at = sceneToCanvas(pinScenePoint(element, pin.point), view);
    places.set(pin.id, { left: Math.round(at.x * 10) / 10, top: Math.round(at.y * 10) / 10 });
  }
  return places;
}

/** The pins' places, read by the pins with useSyncExternalStore. */
export function createPinPlacesStore() {
  let current = NO_PLACES;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next: ReadonlyMap<string, PinPlace>) {
      if (next.size === current.size && [...next].every(([id, place]) => current.get(id)?.left === place.left && current.get(id)?.top === place.top)) return;
      current = next;
      for (const listener of listeners) listener();
    },
  };
}

export type PinPlacesStore = ReturnType<typeof createPinPlacesStore>;

/**
 * The pins, over the canvas and under its islands. A pin's bottom-left
 * corner is its point: its element's top-right corner, or the spot the
 * comment marks. Pins whose element is gone are not drawn.
 */
export function CanvasPins({ pins, places, onOpen }: { pins: readonly CanvasPin[]; places: PinPlacesStore; onOpen: (pin: CanvasPin) => void }) {
  const at = useSyncExternalStore(places.subscribe, places.get, places.get);
  if (pins.length === 0) return null;
  return (
    <div data-slot="canvas-comments" className="pointer-events-none absolute inset-0 z-[2] overflow-hidden">
      {pins.map((pin) => {
        const place = at.get(pin.id);
        if (!place) return null;
        return (
          <CommentMarker
            key={pin.id}
            variant="element"
            count={Math.max(1, pin.threadIds.length)}
            label={pin.label}
            active={pin.active}
            data-pin={pin.id}
            className="pointer-events-auto absolute -translate-y-full"
            style={{ left: place.left, top: place.top }}
            onClick={() => onOpen(pin)}
          />
        );
      })}
    </div>
  );
}

/**
 * Comment, first in Excalidraw's own menu for an element, while that menu
 * is open on one element. Excalidraw's menu takes no items of the page's
 * (its labels are its own translations), so the item is added to its list
 * in its own markup and taken out when the menu closes. It closes the menu
 * and comments on the element, at the spot the menu was opened on.
 */
export function ElementMenuComment({
  store,
  wrapperRef,
  shortcut,
  onComment,
}: {
  store: CanvasUiStore;
  wrapperRef: RefObject<HTMLDivElement | null>;
  shortcut: { label: string; aria: string };
  /** `at` is where the menu was opened, relative to the canvas. */
  onComment: (elementId: string, at: { x: number; y: number }) => void;
}) {
  const ui = useSyncExternalStore(store.subscribe, store.get, store.get);
  const menu = ui.elementMenu;
  const elementId = ui.single;
  const left = menu?.left ?? null;
  const top = menu?.top ?? null;
  useEffect(() => {
    const list = wrapperRef.current?.querySelector(".excalidraw .context-menu");
    if (left === null || top === null || elementId === null || !list) return;
    const item = document.createElement("li");
    item.dataset.slot = "comment-menu-item";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "context-menu-item";
    button.setAttribute("aria-keyshortcuts", shortcut.aria);
    const label = document.createElement("div");
    label.className = "context-menu-item__label";
    label.textContent = "Comment";
    const key = document.createElement("kbd");
    key.className = "context-menu-item__shortcut";
    key.textContent = shortcut.label;
    button.append(label, key);
    button.addEventListener("click", () => onComment(elementId, { x: left, y: top }));
    const separator = document.createElement("hr");
    separator.className = "context-menu-item-separator";
    item.append(button);
    list.prepend(item, separator);
    // Excalidraw fitted its menu into the whole canvas before this item was
    // in it. Fit it into the part a person can see (the canvas runs under the
    // floating header), or let it scroll there when it is too tall.
    const popover = list.closest<HTMLElement>(".popover");
    const visible = wrapperRef.current?.querySelector<HTMLElement>('[data-slot="canvas-controls"]');
    if (popover && visible) {
      const room = visible.getBoundingClientRect();
      const box = popover.getBoundingClientRect();
      if (box.height > room.height - 20) {
        popover.style.top = `${popover.offsetTop + room.top + 10 - box.top}px`;
        popover.style.height = `${room.height - 20}px`;
        popover.style.overflowY = "auto";
      } else {
        const top = Math.min(Math.max(box.top, room.top), room.bottom - box.height);
        if (top !== box.top) popover.style.top = `${popover.offsetTop + top - box.top}px`;
      }
    }
    return () => {
      item.remove();
      separator.remove();
    };
  }, [elementId, left, top, onComment, shortcut.aria, shortcut.label, wrapperRef]);
  return null;
}
