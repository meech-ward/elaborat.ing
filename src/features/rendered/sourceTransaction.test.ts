import { expect, test } from "bun:test";
import { acceptSourceTransaction } from "./sourceTransaction";
import type { DocumentSnapshot } from "../document";

const snapshot: DocumentSnapshot = {
  text: "Original.",
  revision: 3,
  format: "mdx",
};
test("a complete prepared transaction crosses the source port exactly once", async () => {
  const commits: string[] = [];
  expect(
    await acceptSourceTransaction({
      snapshot,
      epoch: 1,
      current: () => ({ snapshot, epoch: 1 }),
      prepare: async () => "All steps checked",
      commit: (value) => {
        commits.push(value);
      },
    }),
  ).toBe("accepted");
  expect(commits).toEqual(["All steps checked"]);
});
test("a rejected later step never crosses the source port", async () => {
  let commits = 0;
  await expect(
    acceptSourceTransaction({
      snapshot,
      epoch: 1,
      current: () => ({ snapshot, epoch: 1 }),
      prepare: async () => {
        throw new Error("Step two crosses a computed island");
      },
      commit: () => {
        commits++;
      },
    }),
  ).rejects.toThrow("Step two");
  expect(commits).toBe(0);
});
test("Source edit/history or identical-byte reload invalidates queued parsing", async () => {
  for (const next of [
    { snapshot: { ...snapshot, text: "External edit", revision: 4 }, epoch: 1 },
    { snapshot, epoch: 2 },
  ]) {
    let state = { snapshot, epoch: 1 },
      commits = 0;
    let complete!: (value: string) => void;
    const prepared = new Promise<string>((resolve) => {
      complete = resolve;
    });
    const pending = acceptSourceTransaction({
      snapshot,
      epoch: 1,
      current: () => state,
      prepare: () => prepared,
      commit: () => {
        commits++;
      },
    });
    state = next;
    complete("Obsolete result");
    expect(await pending).toBe("stale");
    expect(commits).toBe(0);
  }
});
