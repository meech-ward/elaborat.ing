/**
 * On a desktop, each open file's controls (view switch, saved state, file
 * actions) sit in the editor's single top line beside the tabs. The line
 * provides a slot; the active file's view puts its controls there. Without a
 * slot (on a phone) the controls stay in the view.
 */
import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

const TablineSlot = createContext<HTMLElement | null>(null);

export const TablineSlotProvider = TablineSlot.Provider;

export function TablineActions({ active, children }: { active: boolean; children: ReactNode }) {
  const slot = useContext(TablineSlot);
  if (!slot) return <>{children}</>;
  return active ? createPortal(children, slot) : null;
}

/** True inside the desktop frame (the editor has a top line), false on a phone. */
export function useDesktopFrame(): boolean {
  return useContext(TablineSlot) !== null;
}
