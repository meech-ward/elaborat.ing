import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";

export const compactWorkbenchQuery = "(max-width: 650px), (pointer: coarse) and (max-width: 950px) and (max-height: 500px)";

// Every compact-aware view shares one browser query and one listener.
// Subscribers only choose presentation; no session or project state lives here.
let query: MediaQueryList | undefined;
const listeners = new Set<() => void>();
const media = () => query ??= window.matchMedia(compactWorkbenchQuery);
const changed = () => { for (const listener of listeners) listener(); };
function subscribe(listener: () => void) {
  if (!listeners.size) media().addEventListener("change", changed);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) media().removeEventListener("change", changed);
  };
}
export function useCompactWorkbench() {
  return useSyncExternalStore(subscribe, () => media().matches, () => false);
}

function subscribeOnline(listener: () => void) {
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => {
    window.removeEventListener("online", listener);
    window.removeEventListener("offline", listener);
  };
}
export function useWorkbenchOnline() {
  return useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
}

/** Only the toolbar identity is composed here. Each view retains its handlers. */
export function CompactFileIdentity({ navigation, path }: { navigation?: ReactNode; path: string }) {
  if (!navigation) return null;
  return <>{navigation}<span className="wb-compact-filename" title={path} aria-label={path}>{path.split("/").pop()}</span></>;
}

// The keyboard can shrink/pan the visual viewport without changing layout
// viewport units. Keep the sheet header and its scroll area inside that space.
export function useSheetViewport(open: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const viewport = window.visualViewport;
    const update = () => {
      ref.current?.style.setProperty("--sheet-height", `${viewport?.height ?? window.innerHeight}px`);
      ref.current?.style.setProperty("--sheet-top", `${viewport?.offsetTop ?? 0}px`);
    };
    update();
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    return () => {
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
    };
  }, [open]);
  return ref;
}
