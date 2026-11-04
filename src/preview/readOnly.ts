import { useSyncExternalStore } from "react";

/**
 * Whether the parent's latest render said the document is read-only: the
 * person is a viewer, or the project is archived. Set before each render, so
 * everything rendered reads the same value; the parent refuses edits either
 * way.
 */
let readOnly = false;
const listeners = new Set<() => void>();

export function setReadOnly(value: boolean): void {
  if (value === readOnly) return;
  readOnly = value;
  for (const listener of listeners) listener();
}

export function isReadOnly(): boolean {
  return readOnly;
}

export function subscribeReadOnly(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * isReadOnly() for rendering. An island React does not render again on a
 * keystroke (preview-entry.tsx) still follows the document becoming
 * read-only, or editable again.
 */
export function useReadOnly(): boolean {
  return useSyncExternalStore(subscribeReadOnly, isReadOnly);
}
