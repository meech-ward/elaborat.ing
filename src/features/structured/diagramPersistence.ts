import type { DrawingScene } from "@/features/drawings/types.ts";
import type { GeneratedBaseline } from "@/features/structured/types.ts";
import { collectOverrides, writeSidecarFile } from "./structuredClient";

/** Full persisted generation base, including the empty-override case. */
export function diagramSidecarText(baseline: GeneratedBaseline | null, scene: DrawingScene): string | null {
  if (!baseline) return null;
  return writeSidecarFile(collectOverrides(baseline, scene) ?? {
    version: 1,
    language: "d2",
    sourceHash: baseline.sourceHash,
    overrides: {},
    baseline,
  });
}
