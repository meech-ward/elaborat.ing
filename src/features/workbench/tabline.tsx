/**
 * On a desktop, the open file's header controls (its view switch and Save)
 * sit in the editor's top line beside the tabs, and its file actions open
 * from its tab. The line provides a slot for the controls, and a registry
 * the tabs read each file's actions from; each file's view fills them.
 * Without a slot (on a phone) the view keeps its controls in its own header.
 */
import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { MenuEntry } from "@/features/design-system";

type FileActions = Map<string, () => readonly MenuEntry[]>;

const TablineSlot = createContext<HTMLElement | null>(null);
const TablineFileActions = createContext<FileActions | null>(null);

export function TablineProvider({ slot, children }: { slot: HTMLElement | null; children: ReactNode }) {
  const [actions] = useState<FileActions>(() => new Map());
  return (
    <TablineFileActions.Provider value={actions}>
      <TablineSlot.Provider value={slot}>{children}</TablineSlot.Provider>
    </TablineFileActions.Provider>
  );
}

export function TablineActions({ active, children }: { active: boolean; children: ReactNode }) {
  const slot = useContext(TablineSlot);
  if (!slot) return <>{children}</>;
  return active ? createPortal(children, slot) : null;
}

/** True inside the desktop frame (the editor has a top line), false on a phone. */
export function useDesktopFrame(): boolean {
  return useContext(TablineSlot) !== null;
}

/** Offers a file's actions (its tab's menu); the latest entries are read when the menu opens. */
export function useFileActions(path: string, entries: readonly MenuEntry[]) {
  const registry = useContext(TablineFileActions);
  const latest = useRef(entries);
  useLayoutEffect(() => {
    latest.current = entries;
  });
  useLayoutEffect(() => {
    if (!registry) return;
    const read = () => latest.current;
    registry.set(path, read);
    return () => {
      if (registry.get(path) === read) registry.delete(path);
    };
  }, [registry, path]);
}

/** A file's actions, as its view last offered them (none before it has). */
export function useReadFileActions(): (path: string) => readonly MenuEntry[] {
  const registry = useContext(TablineFileActions);
  return (path) => registry?.get(path)?.() ?? [];
}
