import { useRef, useState } from 'react';
import { captureSourceDraft, getSourceDraft, restoreSourceDraft, type DraftRegion } from './sourceDrafts';

/** A direct, in-place editor for one parent-authorized literal property. */
export function InlineLiteral({ value, label, onCommit, sourceRegion }: {
  value: string; label: string; onCommit: (value: string) => void;
  sourceRegion?: DraftRegion;
}) {
  const pending = sourceRegion ? getSourceDraft(sourceRegion) : undefined;
  const [editing, setEditing] = useState(!!pending);
  const [draft, setDraft] = useState(pending?.value ?? value);
  const settled = useRef(false);
  const commit = () => {
    if (settled.current) return;
    settled.current = true;
    setEditing(false);
    if (draft !== value) onCommit(draft);
  };
  return editing ? <input
    className="source-literal-input"
    aria-label={label}
    data-authoring-from={sourceRegion?.from}
    data-authoring-to={sourceRegion?.to}
    data-authoring-expected={sourceRegion?.expected}
    data-authoring-value={value}
    value={draft}
    size={Math.min(60, Math.max(4, draft.length))}
    autoFocus={!pending || pending.focused}
    ref={(input) => { if (input && sourceRegion) restoreSourceDraft(input); }}
    onChange={(event) => {
      setDraft(event.currentTarget.value);
      if (sourceRegion) captureSourceDraft(event.currentTarget);
    }}
    onBlur={(event) => {
      if (sourceRegion) captureSourceDraft(event.currentTarget);
      commit();
    }}
    onKeyDown={(event) => {
      event.stopPropagation();
      if (event.nativeEvent.isComposing) return;
      if (event.key === 'Enter') { event.preventDefault(); commit(); }
      if (event.key === 'Escape') {
        event.preventDefault();
        settled.current = true;
        event.currentTarget.value = value;
        event.currentTarget.blur();
        if (sourceRegion) captureSourceDraft(event.currentTarget);
        setEditing(false);
      }
    }}
  /> : <button
    className="source-literal-trigger"
    type="button"
    aria-label={`Edit ${label}`}
    onClick={(event) => {
      event.preventDefault(); event.stopPropagation();
      settled.current = false; setDraft(value); setEditing(true);
    }}
  >{value || '\u00a0'}</button>;
}
