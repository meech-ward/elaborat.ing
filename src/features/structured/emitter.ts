import { elementIdForConnection, elementIdForLabel, elementIdForShape } from './merge.ts';
import type {
  AngularPoint,
  D2Connection,
  D2Diagram,
  D2Shape,
  D2TableColumn,
  Diagnostic,
  ExcalidrawElementSkeleton,
} from './types.ts';

export type EmitResult = {
  elements: ExcalidrawElementSkeleton[];
  diagnostics: Diagnostic[];
};

const LABEL_FONT_SIZE = 16;
const LABEL_LINE_HEIGHT = 1.25;
const LABEL_FONT_FAMILY = 5; // Pinned native Excalifont, also supplied to D2.
const BINDING_GAP = 10;

function hash32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function isFinitePositive(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

function baseElement(
  id: string,
  type: string,
  x: number,
  y: number,
  width: number,
  height: number,
  index: string,
): ExcalidrawElementSkeleton {
  return {
    id,
    type,
    x: round2(x),
    y: round2(y),
    width: round2(width),
    height: round2(height),
    angle: 0,
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index,
    roundness: type === 'rectangle' ? { type: 3 } : null,
    seed: hash32(`seed:${id}`),
    version: 1,
    versionNonce: hash32(`nonce:${id}`) % 2147483647,
    isDeleted: false,
    boundElements: [],
    updated: 1,
    link: null,
    locked: false,
  };
}

function textElement(
  id: string,
  text: string,
  centerX: number,
  centerY: number,
  width: number,
  height: number,
  containerId: string | null,
  index: string,
  textAlign: 'center' | 'left' = 'center',
  fontSize = LABEL_FONT_SIZE,
): ExcalidrawElementSkeleton {
  const el = baseElement(id, 'text', centerX - width / 2, centerY - height / 2, width, height, index);
  return {
    ...el,
    boundElements: null,
    text,
    fontSize,
    fontFamily: LABEL_FONT_FAMILY,
    textAlign,
    verticalAlign: 'middle',
    containerId,
    originalText: text,
    autoResize: true,
    lineHeight: LABEL_LINE_HEIGHT,
  };
}

/** D2 measures the same pinned font; native line boxes use its own line height. */
function labelBox(text: string, shape: { labelWidth?: number; labelHeight?: number; fontSize?: number }, maxWidth: number): {
  width: number;
  height: number;
  fontSize: number;
} {
  const width = isFinitePositive(shape.labelWidth)
    ? shape.labelWidth
    : Math.max(20, Math.min(maxWidth, Math.max(...text.split('\n').map((l) => l.length)) * 12));
  const lines = text.split('\n').length;
  const fontSize = isFinitePositive(shape.fontSize) ? shape.fontSize : LABEL_FONT_SIZE;
  const height = round2(lines * fontSize * LABEL_LINE_HEIGHT);
  return { width: round2(width), height, fontSize };
}

/** Native type for a D2 shape type. Falls back with a warning, never a drop. */
function nativeShapeType(d2Type: string): { type: string; fallback: string | null } {
  switch (d2Type) {
    case 'rectangle':
    case 'square':
      return { type: 'rectangle', fallback: null };
    case 'oval':
    case 'circle':
      return { type: 'ellipse', fallback: null };
    case 'diamond':
      return { type: 'diamond', fallback: null };
    case 'text':
      return { type: 'text', fallback: null };
    default:
      return { type: d2Type === 'cloud' || d2Type === 'oval' ? 'ellipse' : 'rectangle', fallback: d2Type || '(missing type)' };
  }
}

type EmitContext = {
  elements: ExcalidrawElementSkeleton[];
  diagnostics: Diagnostic[];
  shapeIndex: Map<string, ExcalidrawElementSkeleton>;
  containerIds: Set<string>;
  nextIndex: number;
};

/**
 * Valid fractional-index keys in Excalidraw's observed sequence.
 *
 * Real native files order elements `a0..a9, aa..az` (see the drawings
 * fixtures): a bare `a${n}` counter produces `a10`, which sorts before
 * `a2` and breaks canvas order past ten elements. This continues the same
 * alphabet in phases (`a0..az`, then `b00..bzz`, then `c000..`) so keys
 * stay unique and lexicographically ordered for any element count while
 * the first 36 match native output exactly.
 */
export function fractionalIndex(n: number): string {
  if (!Number.isInteger(n) || n < 0) throw new Error(`invalid element order ${String(n)}`);
  let phase = 0;
  let offset = n;
  for (;;) {
    const width = phase + 1;
    const capacity = 36 ** width;
    if (offset < capacity) {
      const head = String.fromCharCode('a'.charCodeAt(0) + phase);
      return head + offset.toString(36).padStart(width, '0');
    }
    offset -= capacity;
    phase += 1;
    if (phase > 25) throw new Error(`element order ${String(n)} exceeds the fractional-index range`);
  }
}

function takeIndex(ctx: EmitContext): string {
  const index = fractionalIndex(ctx.nextIndex);
  ctx.nextIndex += 1;
  return index;
}

function pushBound(container: ExcalidrawElementSkeleton, type: string, id: string): void {
  (container.boundElements as { type: string; id: string }[]).push({ type, id });
}

function emitLabel(
  ctx: EmitContext,
  ownerId: string,
  owner: ExcalidrawElementSkeleton,
  text: string,
  measured: { labelWidth?: number; labelHeight?: number; fontSize?: number },
  maxWidth: number,
): void {
  const labelId = elementIdForLabel(ownerId);
  const box = labelBox(text, measured, maxWidth);
  const label = textElement(
    labelId,
    text,
    (owner.x as number) + (owner.width as number) / 2,
    (owner.y as number) + (owner.height as number) / 2,
    box.width,
    box.height,
    ownerId,
    takeIndex(ctx),
    'center',
    box.fontSize,
  );
  ctx.elements.push(label);
  pushBound(owner, 'text', labelId);
}

function columnRowText(column: D2TableColumn): string | null {
  const name = column?.name?.label;
  if (!name) return null;
  const typeLabel = column?.type?.label;
  const constraints = Array.isArray(column?.constraint) ? (column.constraint as string[]) : [];
  const marks: string[] = [];
  if (constraints.includes('primary_key')) marks.push('[PK]');
  if (constraints.includes('foreign_key')) marks.push('[FK]');
  if (constraints.includes('unique')) marks.push('[U]');
  return `${name}${typeLabel ? `: ${typeLabel}` : ''}${marks.length ? ` ${marks.join(' ')}` : ''}`;
}

function emitTable(
  ctx: EmitContext,
  shape: D2Shape,
  id: string,
  posX: number,
  posY: number,
  width: number,
  height: number,
  frameId: string | null,
): void {
  const columns = Array.isArray(shape.columns) ? shape.columns : [];
  const rows = columns.map(columnRowText).filter((r): r is string => r !== null);
  const box = baseElement(id, 'rectangle', posX, posY, width, height, takeIndex(ctx));
  if (frameId) box.frameId = frameId;
  ctx.elements.push(box);
  ctx.shapeIndex.set(shape.id, box);

  // Header: the table name, bound to the box.
  const header = shape.label ?? shape.id;
  const headerBox = labelBox(header, shape, Math.max(40, width - 16));
  const headerEl = textElement(
    elementIdForLabel(id),
    header,
    posX + width / 2,
    posY + 8 + headerBox.height / 2,
    headerBox.width,
    headerBox.height,
    id,
    takeIndex(ctx),
    'center',
    headerBox.fontSize,
  );
  ctx.elements.push(headerEl);
  pushBound(box, 'text', headerEl.id);

  // One native text row per column, stacked inside the measured box.
  let cursorY = posY + 8 + headerBox.height + 6;
  rows.forEach((rowText, rowIndex) => {
    const rowHeight = 26;
    const rowId = `${id}:col:${columns[rowIndex]?.name?.label ?? rowIndex}`;
    const rowEl = textElement(
      rowId,
      rowText,
      posX + 12 + (width - 24) / 2,
      cursorY + rowHeight / 2,
      Math.max(20, width - 24),
      rowHeight,
      null,
      takeIndex(ctx),
      'left',
    );
    ctx.elements.push(rowEl);
    cursorY += rowHeight;
  });
  if (cursorY > posY + height + 1) {
    ctx.diagnostics.push({
      severity: 'warning',
      code: 'emit/table-overflow',
      message: `Table "${shape.id}" rows overflow D2's measured box; rows are kept and may need a wider table.`,
      elementId: id,
    });
  }
  if (rows.length === 0) {
    ctx.diagnostics.push({
      severity: 'info',
      code: 'emit/table-no-columns',
      message: `Table "${shape.id}" carries no column data; emitted as a labelled box.`,
      elementId: id,
    });
  }
}

function emitShape(shape: D2Shape, ctx: EmitContext, frameId: string | null): void {
  const id = elementIdForShape(shape.id);
  const posX = typeof shape.pos?.x === 'number' && Number.isFinite(shape.pos.x) ? shape.pos.x : 0;
  const posY = typeof shape.pos?.y === 'number' && Number.isFinite(shape.pos.y) ? shape.pos.y : 0;
  let width = shape.width;
  let height = shape.height;
  if (!isFinitePositive(width) || !isFinitePositive(height)) {
    ctx.diagnostics.push({
      severity: 'warning',
      code: 'emit/shape-no-size',
      message: `Shape "${shape.id}" has no measured size; defaulted to 120x60.`,
      elementId: id,
    });
    if (!isFinitePositive(width)) width = 120;
    if (!isFinitePositive(height)) height = 60;
  }

  // D2 containers arrive flat: a shape whose id prefixes another shape's
  // dotted id (infra vs infra.web) is the group. It becomes a frame.
  if (ctx.containerIds.has(shape.id)) {
    const frame = baseElement(id, 'frame', posX, posY, width, height, takeIndex(ctx));
    frame.name = shape.label ?? shape.id;
    ctx.elements.push(frame);
    ctx.shapeIndex.set(shape.id, frame);
    if (shape.label) {
      const box = labelBox(shape.label, shape, Math.max(40, width - 16));
      const label = textElement(
        elementIdForLabel(id),
        shape.label,
        posX + width / 2,
        posY + 14,
        box.width,
        box.height,
        null,
        takeIndex(ctx),
        'center',
        box.fontSize,
      );
      ctx.elements.push(label);
    }
    return;
  }

  const { type, fallback } = nativeShapeType(shape.type ?? '');
  if (fallback && shape.type !== 'sql_table') {
    ctx.diagnostics.push({
      severity: 'warning',
      code: 'emit/shape-fallback',
      message: `D2 shape "${fallback}" (id "${shape.id}") has no native counterpart; emitted as ${type}.`,
      elementId: id,
    });
  }

  if (type === 'text') {
    const label = shape.label ?? shape.id;
    const box = labelBox(label, shape, Math.max(width, 40));
    const el = textElement(id, label, posX + width / 2, posY + height / 2, box.width, box.height, null, takeIndex(ctx), 'center', box.fontSize);
    ctx.elements.push(el);
    ctx.shapeIndex.set(shape.id, el);
    return;
  }

  if (shape.type === 'sql_table') {
    ctx.diagnostics.push({
      severity: 'info',
      code: 'emit/table-columns',
      message: `Table "${shape.id}" emitted as a native box with one text row per column.`,
      elementId: id,
    });
    emitTable(ctx, shape, id, posX, posY, width, height, frameId);
    return;
  }

  const node = baseElement(id, type, posX, posY, width, height, takeIndex(ctx));
  if (frameId) node.frameId = frameId;
  ctx.elements.push(node);
  ctx.shapeIndex.set(shape.id, node);

  if (shape.label) {
    emitLabel(ctx, id, node, shape.label, shape, Math.max(40, width - 16));
  }
}

function hasArrowHead(marker: string | undefined): boolean {
  if (!marker) return false;
  const m = marker.toLowerCase();
  return m !== '' && m !== 'none';
}

/**
 * Point halfway along the route by arc length.
 *
 * D2 0.1.33 reports `labelPosition: INSIDE_MIDDLE_CENTER` with measured
 * `labelWidth`/`labelHeight` but a `labelPercentage` of 0, i.e. no usable
 * anchor fraction, so the honest placement is the geometric middle of the
 * drawn path. Interpolating by arc length (rather than picking the middle
 * vertex) keeps the label on the path when segments have uneven lengths.
 */
function midpoint(route: AngularPoint[]): AngularPoint {
  if (route.length === 0) return { x: 0, y: 0 };
  let total = 0;
  const cumulative: number[] = [0];
  for (let i = 1; i < route.length; i++) {
    total += Math.hypot(route[i]!.x - route[i - 1]!.x, route[i]!.y - route[i - 1]!.y);
    cumulative.push(total);
  }
  if (!(total > 0)) return { ...(route[0] as AngularPoint) };
  const half = total / 2;
  for (let i = 1; i < route.length; i++) {
    if ((cumulative[i] as number) >= half) {
      const prev = cumulative[i - 1] as number;
      const span = (cumulative[i] as number) - prev;
      const t = span > 0 ? (half - prev) / span : 0;
      return {
        x: (route[i - 1] as AngularPoint).x + ((route[i] as AngularPoint).x - (route[i - 1] as AngularPoint).x) * t,
        y: (route[i - 1] as AngularPoint).y + ((route[i] as AngularPoint).y - (route[i - 1] as AngularPoint).y) * t,
      };
    }
  }
  return { ...(route[route.length - 1] as AngularPoint) };
}

/** Resolve a connection endpoint to a shape id, tolerating field refs (`t.col`). */
function resolveEndpoint(ref: string, ctx: EmitContext): string | null {
  if (ctx.shapeIndex.has(ref)) return ref;
  const dot = ref.indexOf('.');
  if (dot > 0 && ctx.shapeIndex.has(ref.slice(0, dot))) return ref.slice(0, dot);
  return null;
}

/** ELK routes are orthogonal before D2 clips them to shape outlines. The
 * pinned compiler introduces up to a one-pixel offset at oval/diamond ports.
 * Snap only that endpoint coordinate to its adjacent segment; never turn
 * Bezier controls or an arbitrary diagonal route into guessed waypoints. */
function elbowRoute(points: AngularPoint[], isCurve: boolean): AngularPoint[] | null {
  if (isCurve || points.length < 2) return null;
  const route = points.map((point) => ({ x: round2(point.x), y: round2(point.y) }));
  const snap = (point: AngularPoint, adjacent: AngularPoint) => {
    const dx = Math.abs(point.x - adjacent.x), dy = Math.abs(point.y - adjacent.y);
    if (dx <= 1 && dx < dy) point.x = adjacent.x;
    else if (dy <= 1 && dy < dx) point.y = adjacent.y;
  };
  if (route.length === 2) snap(route[1], route[0]);
  else { snap(route[0], route[1]); snap(route[route.length - 1], route[route.length - 2]); }
  if (!route.slice(1).every((point, index) => point.x === route[index].x || point.y === route[index].y)) return null;
  // Native elbows require distinct endpoints and no zero-length segments.
  const distinct = route.filter((point, index) => !index || point.x !== route[index - 1].x || point.y !== route[index - 1].y);
  return distinct.length >= 2 ? distinct : null;
}

const ELBOW_BINDING_GAP = 5; // Excalidraw 0.18.1 FIXED_BINDING_DISTANCE.

function elbowBinding(shape: ExcalidrawElementSkeleton, point: AngularPoint) {
  // Native fixedPoint is a ratio of the unrotated box, not a pixel offset.
  // Avoid exact .5 as the vendor itself does when normalizing fixed points.
  const ratio = (value: number) => Math.abs(value - 0.5) < 0.0001 ? 0.5001 : value;
  return { elementId: shape.id, focus: 0, gap: ELBOW_BINDING_GAP, fixedPoint: [ratio((point.x - shape.x) / shape.width), ratio((point.y - shape.y) / shape.height)] };
}

function emitConnection(conn: D2Connection, ctx: EmitContext): void {
  const id = elementIdForConnection(conn.id);
  const srcId = resolveEndpoint(conn.src, ctx);
  const dstId = resolveEndpoint(conn.dst, ctx);
  if (!srcId || !dstId) {
    const missing = [!srcId ? conn.src : null, !dstId ? conn.dst : null].filter(Boolean).join(', ');
    ctx.diagnostics.push({
      severity: 'warning',
      code: 'emit/unbound-connection',
      message: `Connection "${conn.id}" references unknown shape(s): ${missing}. Emitted without that binding.`,
      elementId: id,
    });
  }

  let route = Array.isArray(conn.route) ? conn.route.filter((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y)) : [];
  const hasMeasuredRoute = route.length >= 2;
  if (route.length < 2) {
    // Never drop the edge: fall back to a straight center-to-center line.
    const a = srcId ? ctx.shapeIndex.get(srcId) : undefined;
    const b = dstId ? ctx.shapeIndex.get(dstId) : undefined;
    if (a && b) {
      route = [
        { x: (a.x as number) + (a.width as number) / 2, y: (a.y as number) + (a.height as number) / 2 },
        { x: (b.x as number) + (b.width as number) / 2, y: (b.y as number) + (b.height as number) / 2 },
      ];
    } else {
      route = [
        { x: 0, y: 0 },
        { x: 60, y: 0 },
      ];
    }
    ctx.diagnostics.push({
      severity: 'warning',
      code: 'emit/connection-no-route',
      message: `Connection "${conn.id}" has no D2 route; emitted as a straight line.`,
      elementId: id,
    });
  }

  const orthogonal = hasMeasuredRoute ? elbowRoute(route, conn.isCurve === true) : null;
  const elbowed = orthogonal !== null;
  if (orthogonal) {
    route = orthogonal;
    // Native elbows keep a five-pixel outline gap. Moving along the existing
    // first/last segment keeps the measured ELK route orthogonal.
    const moveAlong = (point: AngularPoint, adjacent: AngularPoint) => {
      const distance = Math.hypot(adjacent.x - point.x, adjacent.y - point.y);
      const gap = Math.min(ELBOW_BINDING_GAP, distance / 3);
      point.x = round2(point.x + Math.sign(adjacent.x - point.x) * gap);
      point.y = round2(point.y + Math.sign(adjacent.y - point.y) * gap);
    };
    if (srcId) moveAlong(route[0], route[1]);
    if (dstId) moveAlong(route[route.length - 1], route[route.length - 2]);
  } else {
    ctx.diagnostics.push({ severity: 'warning', code: 'emit/non-elbow-route', message: `Connection "${conn.id}" has a non-orthogonal${conn.isCurve ? ' Bezier-control' : ''} route; retained as a non-elbow arrow.`, elementId: id });
  }
  const start = route[0] as AngularPoint;
  const xs = route.map((p) => p.x);
  const ys = route.map((p) => p.y);
  const arrow = baseElement(
    id,
    'arrow',
    start.x,
    start.y,
    Math.max(...xs) - Math.min(...xs),
    Math.max(...ys) - Math.min(...ys),
    takeIndex(ctx),
  );

  const arrowEl: ExcalidrawElementSkeleton = {
    ...arrow,
    points: route.map((p) => [round2(p.x - start.x), round2(p.y - start.y)]),
    lastCommittedPoint: null,
    startBinding: srcId ? elbowed ? elbowBinding(ctx.shapeIndex.get(srcId)!, start) : { elementId: elementIdForShape(srcId), focus: 0, gap: BINDING_GAP } : null,
    endBinding: dstId ? elbowed ? elbowBinding(ctx.shapeIndex.get(dstId)!, route[route.length - 1]) : { elementId: elementIdForShape(dstId), focus: 0, gap: BINDING_GAP } : null,
    startArrowhead: hasArrowHead(conn.srcArrow) ? 'arrow' : null,
    endArrowhead: hasArrowHead(conn.dstArrow) ? 'arrow' : null,
    elbowed,
    ...(elbowed ? { fixedSegments: null, startIsSpecial: null, endIsSpecial: null, roughness: 0 } : {}),
  };
  ctx.elements.push(arrowEl);

  if (srcId) {
    const node = ctx.shapeIndex.get(srcId);
    if (node?.boundElements) pushBound(node, 'arrow', id);
  }
  if (dstId && dstId !== srcId) {
    const node = ctx.shapeIndex.get(dstId);
    if (node?.boundElements) pushBound(node, 'arrow', id);
  }

  if (conn.label) {
    const mid = midpoint(route);
    const box = labelBox(conn.label, conn, 160);
    const label = textElement(elementIdForLabel(id), conn.label, mid.x, mid.y, box.width, box.height, id, takeIndex(ctx), 'center', box.fontSize);
    ctx.elements.push(label);
    pushBound(arrowEl, 'text', label.id);
  }
}

export function emitNativeScene(diagram: D2Diagram): EmitResult {
  const ctx: EmitContext = { elements: [], diagnostics: [], shapeIndex: new Map(), containerIds: new Set(), nextIndex: 0 };
  const shapes = Array.isArray(diagram?.shapes) ? (diagram.shapes as D2Shape[]) : [];
  const connections = Array.isArray(diagram?.connections) ? (diagram.connections as D2Connection[]) : [];
  if (shapes.length === 0 && connections.length === 0) {
    ctx.diagnostics.push({ severity: 'info', code: 'emit/empty-diagram', message: 'D2 produced no shapes or connections.' });
  }
  const ids = new Set(shapes.map((s) => s?.id).filter((id): id is string => typeof id === 'string'));
  for (const id of ids) {
    for (const other of ids) {
      if (other !== id && other.startsWith(id + '.')) {
        ctx.containerIds.add(id);
        break;
      }
    }
  }
  for (const shape of shapes) {
    if (shape && typeof shape.id === 'string') {
      // Dotted children join their longest dotted ancestor's frame.
      let frameId: string | null = null;
      const parts = shape.id.split('.');
      for (let i = parts.length - 1; i >= 1; i--) {
        const ancestor = parts.slice(0, i).join('.');
        if (ctx.containerIds.has(ancestor)) {
          frameId = elementIdForShape(ancestor);
          break;
        }
      }
      emitShape(shape, ctx, frameId);
    } else {
      ctx.diagnostics.push({
        severity: 'warning',
        code: 'emit/shape-no-id',
        message: 'Skipped a D2 shape with no string id; it cannot get a stable element id.',
      });
    }
  }
  for (const conn of connections) {
    if (conn && typeof conn.src === 'string' && typeof conn.dst === 'string') emitConnection(conn, ctx);
    else {
      ctx.diagnostics.push({
        severity: 'warning',
        code: 'emit/connection-no-endpoints',
        message: 'Skipped a D2 connection with missing src/dst.',
      });
    }
  }
  return { elements: ctx.elements, diagnostics: ctx.diagnostics };
}
