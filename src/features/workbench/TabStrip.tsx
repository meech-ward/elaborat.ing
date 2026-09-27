import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { KindBadge } from "./KindBadge";
import type { OpenTab } from "./tabs";
import type { useTabReorder } from "./useTabReorder";

const fileName = (path: string) => path.split("/").pop() ?? path;

/**
 * The open files, in the editor's top line on a desktop. Each tab shows its
 * kind and file name; the active one is raised.
 *
 * Tabs that don't fit stay in the tab list and the accessibility tree,
 * clipped out of view, and "+N" lists them. The active tab is always in
 * view, and so is a tab reached with the arrow keys or moved with
 * Alt+Shift+arrow. A tab list may hold only tabs, so the close mark is a
 * pointer target inside the tab; from the keyboard, Delete closes the
 * focused tab.
 */
export function TabStrip({
  tabs,
  active,
  tabId,
  reorder,
  onSelect,
  onClose,
}: {
  tabs: readonly OpenTab[];
  active: string | null;
  tabId: (path: string) => string;
  reorder: ReturnType<typeof useTabReorder>;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef(active);
  // Tabs not wholly in view, in tab order, and the empty width after the
  // last tab in view (where a clipped tab is), which "+N" moves over.
  // The tab picked from "+N", which gets focus when the menu closes.
  const picked = useRef<string | null>(null);
  const [strip, setStrip] = useState<{ clipped: readonly string[]; gap: number }>({ clipped: [], gap: 0 });
  const { clipped, gap } = strip;

  const measure = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const start = list.scrollLeft;
    const end = start + list.clientWidth;
    const next: string[] = [];
    let edge = 0;
    for (const node of list.clientWidth === 0 ? [] : list.querySelectorAll<HTMLElement>("[data-tab-path]")) {
      const left = node.offsetLeft;
      const right = left + node.offsetWidth;
      if (left < start - 1 || right > end + 1) next.push(node.dataset.tabPath!);
      else edge = Math.max(edge, right - start);
    }
    const nextGap = next.length ? Math.max(0, Math.floor(list.clientWidth - edge)) : 0;
    setStrip((prev) =>
      prev.gap === nextGap && prev.clipped.length === next.length && prev.clipped.every((path, i) => path === next[i])
        ? prev
        : { clipped: next, gap: nextGap },
    );
  }, []);

  // Scroll the strip just enough to show a tab, starting the view at a tab's
  // left edge so no tab is cut on the left.
  const reveal = useCallback((path: string | null) => {
    const list = listRef.current;
    if (!list) return;
    const nodes = [...list.querySelectorAll<HTMLElement>("[data-tab-path]")];
    const node = nodes.find((candidate) => candidate.dataset.tabPath === path);
    if (node) {
      const left = node.offsetLeft;
      const right = left + node.offsetWidth;
      if (left < list.scrollLeft) list.scrollLeft = left;
      else if (right > list.scrollLeft + list.clientWidth)
        list.scrollLeft = nodes.map((candidate) => candidate.offsetLeft).find((start) => start >= right - list.clientWidth && start <= left) ?? left;
    }
    measure();
  }, [measure]);

  const order = tabs.map((tab) => tab.path).join("\n");
  useLayoutEffect(() => {
    activeRef.current = active;
    reveal(active);
  }, [active, order, reveal]);

  // Sizes change with the window, the panels, fonts and the unsaved dots.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    let frame = 0;
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => reveal(activeRef.current));
    });
    observer?.observe(list);
    for (const node of list.querySelectorAll("[data-tab-path]")) observer?.observe(node);
    list.addEventListener("scroll", measure, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      list.removeEventListener("scroll", measure);
    };
  }, [order, reveal, measure]);

  const hidden = tabs.filter((tab) => clipped.includes(tab.path));
  const dragged = reorder.visual;

  return (
    <>
      <TabsList
        ref={listRef}
        className="wb-tabs"
        aria-label="Open files"
        activateOnFocus
        {...reorder.handlers}
        data-reordering={dragged?.animateNeighbors ?? false}
      >
        {tabs.map((tab) => (
          <div
            className="wb-tab"
            data-tab-path={tab.path}
            data-tab-dragging={dragged?.path === tab.path}
            data-clipped={clipped.includes(tab.path)}
            style={{ transform: `translateX(${dragged?.offsets[tab.path] ?? 0}px)` }}
            data-selected={tab.path === active}
            key={tab.path}
          >
            <TabsTrigger
              value={tab.path}
              id={tabId(tab.path)}
              aria-label={tab.path}
              title={`${tab.path} · Drag to reorder; Alt+Shift+Left/Right moves the focused tab; Delete closes it`}
              aria-keyshortcuts="Delete Alt+Shift+ArrowLeft Alt+Shift+ArrowRight"
              onFocus={() => reveal(tab.path)}
              onKeyDown={(event) => {
                if (event.key !== "Delete") return;
                event.preventDefault();
                onClose(tab.path);
              }}
            >
              <KindBadge path={tab.path} />
              {fileName(tab.path)}
              {tab.dirty && <span role="img" aria-label="unsaved changes" className="wb-tab-dirty" />}
              <span
                aria-hidden="true"
                className="wb-tab-close"
                data-tab-close={tab.path}
                onPointerDown={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onClose(tab.path);
                }}
              >
                <X size={12} />
              </span>
            </TabsTrigger>
          </div>
        ))}
      </TabsList>
      {hidden.length > 0 && (
        <Menu>
          <MenuTrigger
            className="wb-tabs-more"
            style={{ left: -gap }}
            aria-label={`${hidden.length} more open ${hidden.length === 1 ? "file" : "files"}`}
            title="More open files"
          >
            +{hidden.length}
          </MenuTrigger>
          <MenuContent
            className="wb-tabs-menu"
            finalFocus={() => {
              // After a pick, focus goes to that tab (which brings it into
              // view), not back to a tab that had focus before.
              const path = picked.current;
              picked.current = null;
              if (!path) return true;
              const tab = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-tab-path]") ?? [])]
                .find((node) => node.dataset.tabPath === path)
                ?.querySelector<HTMLElement>('[role="tab"]');
              tab?.focus();
              return false;
            }}
          >
            {hidden.map((tab) => (
              <MenuItem key={tab.path} onClick={() => { picked.current = tab.path; onSelect(tab.path); }}>
                <KindBadge path={tab.path} />
                <span className="min-w-0 truncate">{fileName(tab.path)}</span>
                {tab.path.includes("/") && (
                  <span className="ml-auto min-w-0 truncate pl-4 text-[11px] text-[var(--muted)] group-data-highlighted:text-[var(--accent-soft-text)]">{tab.path}</span>
                )}
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
      )}
      {dragged && createPortal(
        <div
          className="wb-tab-ghost"
          aria-hidden="true"
          data-settling={dragged.settling}
          style={{ left: dragged.left, top: dragged.top, width: dragged.width, height: dragged.height }}
        >
          <KindBadge path={dragged.path} />
          <span>{fileName(dragged.path)}</span>
          {tabs.find((tab) => tab.path === dragged.path)?.dirty && <span className="wb-tab-dirty" />}
          <X size={12} />
        </div>,
        document.body,
      )}
    </>
  );
}
