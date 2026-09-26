// Agent-readable facts from a native scene.
//
// Reports raw content only: element texts, ids, shapes, positions,
// styles, bindings and dangling arrows. It never invents meaning, and it
// never drops geometry: points and pressures stay in the saved scene.
// Loose (unbound) arrows are listed as preserved annotations, not errors.

import type {
  DrawingElement,
  DrawingScene,
  DrawingSummary,
  DrawingSummaryArrow,
} from './types.ts';

const MAX_DISTINCT_VALUES = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bindingElementId(element: DrawingElement, key: string): string | null {
  const binding = element[key];
  if (!isRecord(binding)) {
    return null;
  }
  return typeof binding['elementId'] === 'string' ? binding['elementId'] : null;
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Summarize one scene. Pure and total: safe on empty, deleted-only and
 * foreign-shaped scenes. Throws only for a shapeless scene argument.
 */
export function summarizeDrawing(scene: DrawingScene): DrawingSummary {
  if (
    typeof scene !== 'object' ||
    scene === null ||
    !Array.isArray((scene as { elements?: unknown }).elements)
  ) {
    throw new Error('invalid scene: expected { type, version, elements: [] }');
  }
  const elements = scene.elements;
  const ids = new Set(elements.map((element) => element.id));

  const byType: Record<string, number> = {};
  let deletedCount = 0;
  const texts: DrawingSummary['texts'] = [];
  const arrows: DrawingSummaryArrow[] = [];
  const danglingArrows: string[] = [];
  const looseArrows: string[] = [];
  const groupIds = new Set<string>();
  const frameIds = new Set<string>();
  const imageIds: string[] = [];
  const strokeColors = new Set<string>();
  const backgroundColors = new Set<string>();
  const customDataElementIds: string[] = [];

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const element of elements) {
    byType[element.type] = (byType[element.type] ?? 0) + 1;
    if (element.isDeleted === true) {
      deletedCount += 1;
      continue;
    }
    if (typeof element.strokeColor === 'string') {
      strokeColors.add(element.strokeColor);
    }
    if (typeof element.backgroundColor === 'string') {
      backgroundColors.add(element.backgroundColor);
    }
    if (element.customData !== undefined) {
      customDataElementIds.push(element.id);
    }
    if (Array.isArray(element.groupIds)) {
      for (const groupId of element.groupIds) {
        if (typeof groupId === 'string') {
          groupIds.add(groupId);
        }
      }
    }
    if (typeof element.frameId === 'string') {
      frameIds.add(element.frameId);
    }
    if (
      typeof element.x === 'number' &&
      typeof element.y === 'number' &&
      Number.isFinite(element.x) &&
      Number.isFinite(element.y)
    ) {
      const width = finiteOr(element.width, 0);
      const height = finiteOr(element.height, 0);
      minX = Math.min(minX, element.x);
      minY = Math.min(minY, element.y);
      maxX = Math.max(maxX, element.x + Math.max(0, width));
      maxY = Math.max(maxY, element.y + Math.max(0, height));
    }

    if (element.type === 'text' && typeof element.text === 'string') {
      texts.push({ id: element.id, text: element.text });
    }
    if (element.type === 'image') {
      if (typeof element.fileId === 'string') {
        imageIds.push(element.fileId);
      } else {
        imageIds.push(element.id);
      }
    }
    if (element.type === 'arrow') {
      const startElementId = bindingElementId(element, 'startBinding');
      const endElementId = bindingElementId(element, 'endBinding');
      const bound =
        startElementId !== null && endElementId !== null
          ? 'both'
          : startElementId !== null
            ? 'start'
            : endElementId !== null
              ? 'end'
              : 'none';
      const dangling =
        (startElementId !== null && !ids.has(startElementId)) ||
        (endElementId !== null && !ids.has(endElementId));
      arrows.push({ id: element.id, startElementId, endElementId, bound, dangling });
      if (dangling) {
        danglingArrows.push(element.id);
      }
      if (bound === 'none') {
        looseArrows.push(element.id);
      }
    }
  }

  const fileIds = scene.files ? Object.keys(scene.files) : [];
  const hasImages = imageIds.length > 0 || fileIds.length > 0;

  return {
    elementCount: elements.length,
    activeCount: elements.length - deletedCount,
    deletedCount,
    byType,
    ids: elements.map((element) => element.id),
    texts,
    bounds:
      minX === Number.POSITIVE_INFINITY
        ? null
        : { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
    arrows,
    danglingArrows,
    looseArrows,
    groupIds: [...groupIds].sort(),
    frameIds: [...frameIds].sort(),
    imageIds,
    hasImages,
    strokeColors: [...strokeColors].sort().slice(0, MAX_DISTINCT_VALUES),
    backgroundColors: [...backgroundColors].sort().slice(0, MAX_DISTINCT_VALUES),
    customDataElementIds,
  };
}
