import * as z from "zod/mini";
import { canMove } from "./moveRules";

/** Private browser drag format. A tree nonce prevents drops across projects or tabs. */
export const EXPLORER_FILE_DRAG_TYPE = "application/x-elaborating-file";
const dragPayload = z.strictObject({
  version: z.literal(1),
  source: z.string().check(z.maxLength(100)),
  path: z.string().check(z.maxLength(512)),
});

/** Files from the OS are left to the existing upload handlers. */
export function isExplorerFileDrag(transfer: Pick<DataTransfer, "types">): boolean {
  return transfer.types.includes(EXPLORER_FILE_DRAG_TYPE) && !transfer.types.includes("Files");
}

export function writeExplorerFileDrag(transfer: Pick<DataTransfer, "setData" | "effectAllowed">, path: string, source: string): void {
  transfer.effectAllowed = "move";
  transfer.setData(EXPLORER_FILE_DRAG_TYPE, JSON.stringify({ version: 1, source, path }));
}

/** The payload is only an identity proposal; the current tree and move planner remain authoritative. */
export function readExplorerFileDrag(transfer: Pick<DataTransfer, "getData">, source: string, paths: ReadonlySet<string>): string | null {
  const value = transfer.getData(EXPLORER_FILE_DRAG_TYPE);
  if (!value || value.length > 2048) return null;
  try {
    const result = dragPayload.safeParse(JSON.parse(value));
    if (!result.success || result.data.source !== source || !paths.has(result.data.path) || !canMove(result.data.path)) return null;
    return result.data.path;
  } catch {
    return null;
  }
}
