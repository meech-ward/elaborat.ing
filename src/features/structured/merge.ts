/**
 * Regeneration merge: recompile the source, keep the human's work.
 *
 * The merge base is the previous {@link GeneratedBaseline} (what the
 * generator produced last time). Every generated element carries a full
 * `snapshot` of that output, so the merge compares field by field:
 *
 * - only the user changed a field (moved, restyled, reworded, added an
 *   unknown native field) -> keep the user's value;
 * - only the fresh compile changed a field (new label, relayout) -> take it;
 * - both changed the same field -> keep the user's value and report a
 *   conflict naming the field;
 * - the user soft-deleted a generated element (`isDeleted`) the source
 *   still generates -> the tombstone stays, with an info diagnostic;
 * - the source dropped an element the user never touched -> it is removed;
 * - the source dropped an element the user changed -> kept + conflict.
 *
 * Elements the generator never owned (freehand annotations, unbound
 * arrows, anything without a `d2:` id) pass through untouched, in order.
 * A code edit can never silently delete a human annotation: removals of
 * user-touched generated elements surface as conflicts, and free elements
 * are never candidates for removal.
 *
 * The scene envelope is preserved: merge and reset rewrite `elements`
 * only, spreading the current scene so `appState`, `files` and any other
 * root fields survive.
 */
import { GENERATED_PREFIX, isGeneratedId } from './generated.ts';
import type {
  ExcalidrawElementSkeleton,
  GeneratedBaseline,
  GeneratedElementRecord,
  MergeConflict,
  MergeResult,
  NativeScene,
  RegenerationRequest,
} from './types.ts';

const LABEL_SUFFIX = ':label';

export function elementIdForShape(shapeId: string): string {
  return `${GENERATED_PREFIX}${shapeId}`;
}

export function elementIdForConnection(connectionId: string): string {
  return `${GENERATED_PREFIX}${connectionId}`;
}

export function elementIdForLabel(ownerElementId: string): string {
  return `${ownerElementId}${LABEL_SUFFIX}`;
}

export { isGeneratedId };

/** Style keys the generator owns and the merge compares. */
const STYLE_KEYS = [
  'strokeColor',
  'backgroundColor',
  'fillStyle',
  'strokeWidth',
  'strokeStyle',
  'roughness',
  'roundness',
  'opacity',
  'fontSize',
  'fontFamily',
  'textAlign',
  'verticalAlign',
  'points',
] as const;

/** Geometry fields: a user drag/resize versus a source relayout. */
const GEOMETRY_FIELDS: ReadonlySet<string> = new Set(['x', 'y', 'width', 'height', 'angle', 'points']);

const STYLE_FIELD_SET: ReadonlySet<string> = new Set(STYLE_KEYS as readonly string[]);

/**
 * Editor metadata the canvas bumps on any save. It never decides a
 * conflict (a genuine edit always changes a content field too); the
 * merged element keeps the live (current) copy.
 */
const VOLATILE_FIELDS: ReadonlySet<string> = new Set(['version', 'updated']);

function clonePlain<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

export function recordForElement(element: ExcalidrawElementSkeleton): GeneratedElementRecord {
  const style: Record<string, unknown> = {};
  for (const key of STYLE_KEYS) {
    if (element[key] !== undefined) style[key] = element[key];
  }
  return {
    x: element.x,
    y: element.y,
    width: element.width,
    height: element.height,
    style,
    snapshot: clonePlain(element as unknown as Record<string, unknown>),
  };
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function snapshotOf(record: GeneratedElementRecord | undefined): Record<string, unknown> {
  return record?.snapshot ?? {};
}

function elementTouched(base: GeneratedElementRecord | undefined, element: ExcalidrawElementSnapshot): boolean {
  const baseSnap = snapshotOf(base);
  const keys = new Set([...Object.keys(baseSnap), ...Object.keys(element)]);
  for (const key of keys) {
    if (key === 'id' || VOLATILE_FIELDS.has(key)) continue;
    if (!valuesEqual(element[key], baseSnap[key])) return true;
  }
  return false;
}

type ExcalidrawElementSnapshot = Record<string, unknown>;

function classifyConflict(fields: string[]): MergeConflict['kind'] {
  if (fields.length > 0 && fields.every((f) => GEOMETRY_FIELDS.has(f))) return 'moved';
  if (fields.length > 0 && fields.every((f) => STYLE_FIELD_SET.has(f))) return 'styled';
  return 'edited';
}

/**
 * Merge one generated element present in all three snapshots.
 * Returns the merged element plus the conflicting field names, if any.
 */
function mergeElementFields(
  elementId: string,
  base: GeneratedElementRecord,
  current: ExcalidrawElementSkeleton,
  fresh: ExcalidrawElementSkeleton,
): { merged: ExcalidrawElementSkeleton; bothChanged: string[] } {
  const baseSnap = snapshotOf(base);
  const currentRec = current as unknown as ExcalidrawElementSnapshot;
  const freshRec = fresh as unknown as ExcalidrawElementSnapshot;
  const merged: ExcalidrawElementSnapshot = { ...clonePlain(freshRec) };
  const bothChanged: string[] = [];
  const keys = new Set([...Object.keys(baseSnap), ...Object.keys(currentRec), ...Object.keys(freshRec)]);
  for (const key of keys) {
    if (key === 'id') {
      merged[key] = elementId;
      continue;
    }
    if (VOLATILE_FIELDS.has(key)) {
      if (currentRec[key] !== undefined) merged[key] = clonePlain(currentRec[key]);
      continue;
    }
    const userChanged = !valuesEqual(currentRec[key], baseSnap[key]);
    const genChanged = !valuesEqual(freshRec[key], baseSnap[key]);
    if (userChanged && !genChanged) {
      if (currentRec[key] === undefined) delete merged[key];
      else merged[key] = clonePlain(currentRec[key]);
    } else if (!userChanged && genChanged) {
      if (freshRec[key] === undefined) delete merged[key];
      else merged[key] = clonePlain(freshRec[key]);
    } else if (userChanged && genChanged) {
      // Convergent edits are not genuine conflicts: both sides moved to
      // the same value, so keep it quietly instead of reporting one.
      if (valuesEqual(currentRec[key], freshRec[key])) {
        if (currentRec[key] === undefined) delete merged[key];
        else merged[key] = clonePlain(currentRec[key]);
        continue;
      }
      if (currentRec[key] === undefined) delete merged[key];
      else merged[key] = clonePlain(currentRec[key]);
      bothChanged.push(key);
    }
    // Neither changed: merged already holds the fresh (== base) value.
  }
  // Switching route representation is not a field-independent edit. A human
  // polyline plus a fresh elbow flag would be invalid native geometry. Keep
  // the authored routing unit together during a layout-engine upgrade; an
  // untouched generated arrow still receives the new native elbow route.
  const routingFields = ['x', 'y', 'width', 'height', 'angle', 'points', 'elbowed', 'startBinding', 'endBinding', 'fixedSegments', 'startIsSpecial', 'endIsSpecial'];
  if (current.type === 'arrow' && baseSnap.elbowed !== freshRec.elbowed && routingFields.some((key) => !valuesEqual(currentRec[key], baseSnap[key]))) {
    for (const key of routingFields) {
      if (currentRec[key] === undefined) delete merged[key];
      else merged[key] = clonePlain(currentRec[key]);
    }
    if (!bothChanged.includes('elbowed')) bothChanged.push('elbowed');
  }
  if (merged['id'] === undefined) merged['id'] = elementId;
  return { merged: merged as unknown as ExcalidrawElementSkeleton, bothChanged };
}

export function mergeRegeneration(request: RegenerationRequest): MergeResult {
  const { baseline, currentScene, freshScene, freshBaseline } = request;
  const conflicts: MergeConflict[] = [];
  const diagnostics: MergeResult['diagnostics'] = [];

  const currentById = new Map(currentScene.elements.map((el) => [el.id, el]));
  const freshById = new Map(freshScene.elements.map((el) => [el.id, el]));
  const baseRecords = baseline?.elements ?? {};

  const out: ExcalidrawElementSkeleton[] = [];
  const emitted = new Set<string>();

  const push = (el: ExcalidrawElementSkeleton): void => {
    if (emitted.has(el.id)) return;
    emitted.add(el.id);
    out.push(el);
  };

  // Walk the current scene in order: free elements stay exactly where they
  // are; generated elements resolve against baseline + fresh output.
  for (const current of currentScene.elements) {
    const base = baseRecords[current.id];
    const fresh = freshById.get(current.id);
    if (!isGeneratedId(current.id) || !base) {
      push(current);
      continue;
    }
    if (!fresh) {
      // Source no longer generates this id.
      if (!elementTouched(base, current as unknown as ExcalidrawElementSnapshot)) {
        diagnostics.push({
          severity: 'info',
          code: 'merge/removed-by-source',
          message: `Removed "${current.id}": the source no longer generates it and it was untouched.`,
          elementId: current.id,
        });
        continue; // drop it
      }
      conflicts.push({
        elementId: current.id,
        kind: 'removed-by-source',
        message: `Kept "${current.id}": you changed it and the new source no longer generates it. Delete it on canvas to accept the source.`,
      });
      push(current);
      continue;
    }
    const baseAlive = snapshotOf(base)['isDeleted'] !== true;
    const userDeleted = baseAlive && (current as unknown as ExcalidrawElementSnapshot)['isDeleted'] === true;
    if (userDeleted) {
      // A deletion dominates: keep the tombstone exactly as the user left
      // it rather than repainting its fields from the fresh output.
      diagnostics.push({
        severity: 'info',
        code: 'merge/kept-deletion',
        message: `Kept deletion of "${current.id}": you deleted it and the source still generates it. Reset overrides to bring it back.`,
        elementId: current.id,
      });
      push(current);
      continue;
    }
    const { merged, bothChanged } = mergeElementFields(current.id, base, current, fresh);
    if (bothChanged.length > 0) {
      const kind = classifyConflict(bothChanged);
      conflicts.push({
        elementId: current.id,
        kind,
        message:
          `Kept your version of "${current.id}" (both sides changed ${bothChanged.join(', ')}). ` +
          `Reset overrides to accept the regenerated layout.`,
      });
    }
    push(merged);
  }

  // Fresh elements the current scene does not have.
  for (const fresh of freshScene.elements) {
    if (emitted.has(fresh.id)) continue;
    const base = baseRecords[fresh.id];
    if (base && currentById.has(fresh.id)) continue; // handled above
    if (base && !currentById.has(fresh.id)) {
      // User deleted this generated element in a previous round: keep it deleted.
      diagnostics.push({
        severity: 'info',
        code: 'merge/kept-deletion',
        message: `Kept deletion of "${fresh.id}": you deleted it and the source still generates it. Reset overrides to bring it back.`,
        elementId: fresh.id,
      });
      continue;
    }
    push(fresh);
  }

  return { scene: { ...currentScene, elements: out }, baseline: freshBaseline, conflicts, diagnostics };
}

/**
 * Explicit reset: forget every override and show exactly what the source
 * generates, while keeping freehand additions. Unlike the merge, a reset
 * restores user-deleted generated elements too. There are no conflicts:
 * calling reset IS the user's decision. Scene root fields ride along.
 */
export function resetOverrides(args: {
  currentScene: NativeScene;
  freshScene: NativeScene;
  freshBaseline: GeneratedBaseline;
}): MergeResult {
  const { currentScene, freshScene, freshBaseline } = args;
  const freshById = new Map(freshScene.elements.map((el) => [el.id, el]));
  const out: ExcalidrawElementSkeleton[] = [];
  const resetIds: string[] = [];

  for (const current of currentScene.elements) {
    if (!isGeneratedId(current.id)) {
      out.push(current);
      continue;
    }
    const fresh = freshById.get(current.id);
    if (fresh) {
      out.push(fresh);
      resetIds.push(current.id);
    }
    // Generated ids the fresh output dropped are removed by an explicit reset.
  }
  for (const fresh of freshScene.elements) {
    if (!out.some((el) => el.id === fresh.id)) out.push(fresh);
  }
  const diagnostics: MergeResult['diagnostics'] = resetIds.length
    ? [
        {
          severity: 'info',
          code: 'merge/reset',
          message: `Reset ${resetIds.length} generated element(s) to the regenerated layout; freehand additions kept.`,
        },
      ]
    : [];
  return { scene: { ...currentScene, elements: out }, baseline: freshBaseline, conflicts: [], diagnostics };
}
