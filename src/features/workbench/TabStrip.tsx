import { createPortal } from "react-dom";
import { EditorTabGhost, KindBadge, TabLine } from "@/features/design-system";
import { kindForPath } from "./session";
import { useReadFileActions } from "./tabline";
import type { OpenTab } from "./tabs";
import type { useTabReorder } from "./useTabReorder";

const fileName = (path: string) => path.split("/").pop() ?? path;
const folder = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : undefined);
const badge = (path: string) => <KindBadge kind={kindForPath(path)} />;

/**
 * The open files, in the editor's top line on a desktop: the library's tab
 * line inside the workbench's Tabs root (which also holds the files' panels).
 * Each tab offers its file's actions on right-click and, on the active tab,
 * from "...". Tabs can be dragged to a new place, and Alt+Shift+Left/Right
 * moves the focused tab; Delete closes it.
 */
export function TabStrip({
  tabs,
  active,
  tabId,
  reorder,
  onSelect,
  onClose,
  className,
}: {
  tabs: readonly OpenTab[];
  active: string | null;
  tabId: (path: string) => string;
  reorder: ReturnType<typeof useTabReorder>;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  className?: string;
}) {
  const fileActions = useReadFileActions();
  const dragged = reorder.visual;
  return (
    <>
      <TabLine
        withinTabs
        className={className}
        items={tabs.map((tab) => ({
          value: tab.path,
          name: fileName(tab.path),
          badge: badge(tab.path),
          dirty: tab.dirty,
          label: tab.path,
          detail: folder(tab.path),
        }))}
        value={active}
        onValueChange={onSelect}
        onClose={onClose}
        actions={fileActions}
        listProps={reorder.handlers}
        tabProps={(item) => ({
          id: tabId(item.value),
          title: `${item.value} · Drag to reorder; Alt+Shift+Left/Right moves the focused tab; Delete closes it`,
          "aria-keyshortcuts": "Delete Alt+Shift+ArrowLeft Alt+Shift+ArrowRight",
        })}
        drag={dragged && { value: dragged.path, offsets: dragged.offsets, slide: dragged.animateNeighbors }}
      />
      {dragged &&
        createPortal(
          <EditorTabGhost
            name={fileName(dragged.path)}
            badge={badge(dragged.path)}
            dirty={tabs.find((tab) => tab.path === dragged.path)?.dirty}
            settling={dragged.settling}
            style={{ left: dragged.left, top: dragged.top, width: dragged.width, height: dragged.height }}
          />,
          document.body,
        )}
    </>
  );
}
