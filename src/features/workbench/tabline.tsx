/**
 * On a desktop, the open file's header controls (its view switch and Save)
 * sit in the editor's top line beside the tabs, and its file actions open
 * from its tab. The line provides a slot for the controls, and a registry
 * the tabs read each file's actions from; each file's view fills them.
 * Without a slot (on a phone) the view keeps its controls in its own header.
 */
import { createContext, useContext, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { MenuEntry } from "@/features/design-system";

type ReadFileActions = (path: string) => readonly MenuEntry[];

/**
 * Each file's latest actions, and a reader the tabs' menus read them with.
 * The reader is new whenever what a file's menu shows changes (Save enabled
 * once an edit has finished, say), so a menu that is open shows it.
 */
function createFileActions() {
  const files = new Map<string, () => readonly MenuEntry[]>();
  const listeners = new Set<() => void>();
  const reader = (): ReadFileActions => (path) => files.get(path)?.() ?? [];
  let read = reader();
  return {
    files,
    read: () => read,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    changed: () => {
      read = reader();
      for (const listener of listeners) listener();
    },
  };
}

type FileActions = ReturnType<typeof createFileActions>;

const TablineSlot = createContext<HTMLElement | null>(null);
const TablineFileActions = createContext<FileActions | null>(null);

export function TablineProvider({ slot, children }: { slot: HTMLElement | null; children: ReactNode }) {
  const [actions] = useState(createFileActions);
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

/** Offers a file's actions (its tab's menu): the latest entries, which an open menu follows. */
export function useFileActions(path: string, entries: readonly MenuEntry[]) {
  const registry = useContext(TablineFileActions);
  const latest = useRef(entries);
  // What the menu shows (every field but onSelect), to tell an open menu only when that changes.
  const shown = useRef("");
  useLayoutEffect(() => {
    if (!registry) return;
    const read = () => latest.current;
    registry.files.set(path, read);
    return () => {
      if (registry.files.get(path) === read) registry.files.delete(path);
    };
  }, [registry, path]);
  useLayoutEffect(() => {
    latest.current = entries;
    const next = JSON.stringify(entries);
    if (next === shown.current) return;
    shown.current = next;
    registry?.changed();
  });
}

// Outside a TablineProvider there is no registry, and so no actions.
const noFileActions: ReadFileActions = () => [];
const readNone = () => noFileActions;
const unsubscribed = () => () => {};

/** A file's actions, as its view last offered them (none before it has). */
export function useReadFileActions(): ReadFileActions {
  const registry = useContext(TablineFileActions);
  return useSyncExternalStore(registry?.subscribe ?? unsubscribed, registry?.read ?? readNone);
}
