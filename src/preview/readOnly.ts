/**
 * Whether the parent's latest render said the document is read-only: the
 * person is a viewer, or the project is archived. Set before each render, so
 * everything rendered reads the same value; the parent refuses edits either
 * way.
 */
let readOnly = false;

export function setReadOnly(value: boolean): void {
  readOnly = value;
}

export function isReadOnly(): boolean {
  return readOnly;
}
