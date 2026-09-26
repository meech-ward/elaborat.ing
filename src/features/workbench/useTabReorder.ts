import { useEffect, useRef, useState, type PointerEvent, type KeyboardEvent } from "react";

type Drop = { path: string; target: string; side: "before" | "after" };
type Item = { path: string; left: number; width: number };
type DragVisual = {
  path: string; left: number; top: number; width: number; height: number;
  settling: boolean; animateNeighbors: boolean; offsets: Record<string, number>;
};
type Gesture = {
  path: string; x: number; y: number; dragging: boolean; grabX: number;
  list: HTMLDivElement; items: Item[]; top: number; height: number;
  destination: number; drop: Drop | null;
};

/** Pointer sorting leaves clicks and ordinary arrow navigation to shadcn Tabs. */
export function useTabReorder(paths: string[], reorder: (drop: Drop) => void) {
  const gesture = useRef<Gesture | null>(null);
  const suppressClick = useRef(false);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [visual, setVisual] = useState<DragVisual | null>(null);
  const finish = (commit: boolean) => {
    const g = gesture.current;
    gesture.current = null;
    if (!g?.dragging) return;
    const item = g.items.find(item => item.path === g.path)!;
    const accepted = commit && g.drop;
    if (accepted) reorder(accepted);
    setVisual({
      path: g.path, top: g.top, width: item.width, height: g.height, settling: true, animateNeighbors: !accepted, offsets: {},
      left: g.list.getBoundingClientRect().left - g.list.scrollLeft + (accepted ? g.destination : item.left),
    });
    settleTimer.current = setTimeout(() => setVisual(null), matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180);
  };
  useEffect(() => {
    // Dragging an inactive tab deliberately leaves focus in the active editor.
    // Escape must therefore be heard outside the tab strip as well.
    const cancel = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || !gesture.current?.dragging) return;
      event.preventDefault(); event.stopPropagation();
      finish(false);
    };
    const blur = () => finish(false);
    window.addEventListener("keydown", cancel, true);
    window.addEventListener("blur", blur);
    return () => { window.removeEventListener("keydown", cancel, true); window.removeEventListener("blur", blur); };
  });
  useEffect(() => () => { if (settleTimer.current) clearTimeout(settleTimer.current); }, []);
  const handlers = {
    onPointerDownCapture(event: PointerEvent<HTMLDivElement>) {
      suppressClick.current = false;
      if (event.button !== 0 || event.pointerType === "touch") return;
      const tab = (event.target as HTMLElement).closest<HTMLElement>('[role="tab"]');
      const path = tab?.closest<HTMLElement>('[data-tab-path]')?.dataset.tabPath;
      if (!path) return;
      if (settleTimer.current) clearTimeout(settleTimer.current);
      setVisual(null);
      // Do not activate an inactive tab merely because it is being dragged.
      // A normal click still reaches the tab's own click handler.
      event.preventDefault();
      const list = event.currentTarget;
      const items = [...list.querySelectorAll<HTMLElement>('[data-tab-path]')].map(node => ({
        path: node.dataset.tabPath!, left: node.offsetLeft, width: node.offsetWidth,
      }));
      const box = tab!.closest<HTMLElement>('[data-tab-path]')!.getBoundingClientRect();
      gesture.current = {
        path, x: event.clientX, y: event.clientY, dragging: false, list, items,
        grabX: event.clientX - box.left, top: box.top, height: box.height,
        destination: items.find(item => item.path === path)!.left, drop: null,
      };
    },
    onPointerMove(event: PointerEvent<HTMLDivElement>) {
      const g = gesture.current;
      if (!g || (!g.dragging && Math.hypot(event.clientX - g.x, event.clientY - g.y) < 5)) return;
      g.dragging = true;
      suppressClick.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left + 32) event.currentTarget.scrollLeft -= 24;
      if (event.clientX > bounds.right - 32) event.currentTarget.scrollLeft += 24;
      // Use original layout positions, never animated boxes: otherwise a
      // neighbor moving beneath the pointer can repeatedly flip the target.
      const item = g.items.find(item => item.path === g.path)!;
      const remaining = g.items.filter(item => item.path !== g.path);
      const x = event.clientX - bounds.left + g.list.scrollLeft;
      const index = remaining.filter(item => x > item.left + item.width / 2).length;
      const target = remaining[index] ?? remaining.at(-1);
      g.drop = target && event.clientY >= bounds.top - 24 && event.clientY <= bounds.bottom + 24
        ? { path: g.path, target: target.path, side: index < remaining.length ? "before" : "after" } : null;
      const projected = [...remaining];
      projected.splice(g.drop ? index : g.items.indexOf(item), 0, item);
      let left = g.items[0].left;
      const offsets: Record<string, number> = {};
      for (const entry of projected) {
        offsets[entry.path] = left - entry.left;
        if (entry === item) g.destination = left;
        left += entry.width;
      }
      setVisual({ path: g.path, left: event.clientX - g.grabX, top: g.top,
        width: item.width, height: g.height, settling: false, animateNeighbors: true, offsets });
    },
    onPointerUp(event: PointerEvent<HTMLDivElement>) {
      if (gesture.current?.dragging) {
        event.preventDefault();
      }
      finish(true);
    },
    onPointerCancel: () => finish(false),
    onLostPointerCapture: () => finish(false),
    onClickCapture(event: React.MouseEvent<HTMLDivElement>) {
      if (suppressClick.current) { event.preventDefault(); event.stopPropagation(); suppressClick.current = false; }
    },
    onKeyDownCapture(event: KeyboardEvent<HTMLDivElement>) {
      if (!event.altKey || !event.shiftKey || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      const tab = (event.target as HTMLElement).closest<HTMLElement>('[role="tab"]');
      const path = tab?.closest<HTMLElement>('[data-tab-path]')?.dataset.tabPath;
      if (!path) return;
      event.preventDefault(); event.stopPropagation();
      const direction = event.key === "ArrowLeft" ? -1 : 1;
      const target = paths[paths.indexOf(path) + direction];
      if (target) {
        reorder({ path, target, side: direction < 0 ? "before" : "after" });
        requestAnimationFrame(() => { tab?.focus({ preventScroll: true }); tab?.scrollIntoView({ block: "nearest", inline: "nearest" }); });
      }
    },
  };
  return { handlers, visual };
}
