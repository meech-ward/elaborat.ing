/**
 * The explorer's field for naming a new file or folder, shown in the folder
 * it goes in, as in a code editor's explorer (the library's TreeNameField).
 * It starts with a proposed name selected up to its extension. Enter creates,
 * Escape cancels, and a name that can't be used says why under the field,
 * which stays open.
 */
import { useEffect, useRef, useState } from "react";
import { TreeNameField } from "@/features/design-system";
import { nameStemLength, newEntryNoun, type NewEntryKind } from "./newEntries";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function NewEntryField({ kind, dir, initial, validate, onCreate, onCancel }: {
  kind: NewEntryKind;
  /** The folder it goes in; "" is the workspace root. */
  dir: string;
  initial: string;
  /** Why a name can't be used, or null. */
  validate: (name: string) => string | null;
  /** Creates the entry. A refusal it throws shows under the field. */
  onCreate: (name: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const field = input.current;
    if (!field) return;
    field.focus();
    field.setSelectionRange(0, nameStemLength(kind, initial));
  }, [kind, initial]);

  const submit = async () => {
    if (pending) return;
    const problem = validate(name);
    if (problem) {
      setError(problem);
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onCreate(name);
    } catch (cause) {
      setError(message(cause));
      setPending(false);
    }
  };

  return (
    <TreeNameField
      ref={input}
      // The rows inside `dir` sit one level below it.
      depth={dir === "" ? 0 : dir.split("/").length}
      value={name}
      error={error}
      aria-label={`Name of the new ${newEntryNoun(kind)} in ${dir === "" ? "the workspace root" : dir}`}
      aria-busy={pending}
      readOnly={pending}
      onChange={(event) => {
        setName(event.target.value);
        setError(null);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          void submit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          if (!pending) onCancel();
        }
      }}
    />
  );
}
