import type { DocumentSnapshot } from "../document";

/** Async parsing owns no authority. Only a still-current complete result may
 * cross the source-store/Monaco commit port. Reload identity is in the epoch. */
export async function acceptSourceTransaction<T>(args: {
  snapshot: DocumentSnapshot;
  epoch: number;
  current: () => { snapshot: DocumentSnapshot; epoch: number };
  prepare: () => Promise<T>;
  commit: (prepared: T) => void;
}): Promise<"accepted" | "stale"> {
  const current = () => {
    const latest = args.current();
    return (
      latest.epoch === args.epoch &&
      latest.snapshot.revision === args.snapshot.revision &&
      latest.snapshot.text === args.snapshot.text &&
      latest.snapshot.format === args.snapshot.format
    );
  };
  if (!current()) return "stale";
  const prepared = await args.prepare();
  if (!current()) return "stale";
  args.commit(prepared);
  return "accepted";
}
