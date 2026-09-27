import { useSyncExternalStore } from "react";

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

