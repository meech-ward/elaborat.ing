import { expect, test } from "bun:test";
import { REFUSAL, refusalNotice } from "./refusal";

test("a refused edit's reason becomes a plain sentence", () => {
  for (const reason of [
    "Selection crosses a protected object",
    "Selection crosses protected unrendered source",
    "Inline mutation touches a protected object",
  ])
    expect(refusalNotice(reason)).toBe(REFUSAL.protected);
  for (const reason of [
    "Stale source projection",
    "Rejected stale frame message (revision 3, current 4).",
    "stale revision: patch targets revision 3 but document is at revision 4",
    "Source rejected the rendered transaction.",
  ])
    expect(refusalNotice(reason)).toBe(REFUSAL.stale);
  for (const reason of [
    "Source projection differs from proposed editor transaction",
    "Unsupported top-level insertion boundary",
    "Unsupported structural serialization",
    "Cannot split an encoded source character",
    "Rejected prop edit outside the exposed literal ranges.",
  ])
    expect(refusalNotice(reason)).toBe(REFUSAL.unwritable);
  for (const sentence of Object.values(REFUSAL)) expect(sentence).not.toMatch(/—/);
});
