// Elements that arrive in a version saved elsewhere, such as an agent's save,
// are sketched in one after another in the scene's order, the way the chat
// card draws a drawing as it is written (src/features/sketch): each line
// drawn along its length, hachure scribbled in, solid fills faded in after
// their outline, text written left to right, each with a quiet pencil stroke.
//
// The canvas keeps them hidden while an SVG over it, which follows its scroll
// and zoom, sketches them. Each is drawn there by Excalidraw's own SVG export
// (exportToSvg): the same rough strokes from the same seeds, and the same text
// layout, as the canvas draws. When one is drawn, the canvas shows it before
// the next paint and its sketch fades over it (HANDOVER_MS), so nothing moves
// where the canvas puts it a fraction of a pixel apart. A big addition draws
// faster, so the whole sketch takes about SKETCH_BUDGET_MS at most. Display
// only, like the rest of DrawingCanvas's `drawIn`: outside undo, and never in
// the file.

import type { Pencil } from '@/features/sketch/pencil.ts';
import { itemMs, NEXT_AT, playSteps, sketchMs, stepsOf, STROKE_GAP_MS, type Step } from '@/features/sketch/steps.ts';
import { DARK_FILTER } from './presentation.ts';
import { repairNativeSvgMasks } from './svgMask.ts';

/** About the longest a sketch takes: a bigger addition draws faster. */
export const SKETCH_BUDGET_MS = 6000;

/**
 * How long a drawn element's sketch takes to go once the canvas shows it.
 * The canvas draws each element from a picture of its own that it puts on
 * whole pixels, so its copy can sit a fraction of a pixel from the sketch's:
 * the sketch fading over it settles the difference instead of snapping.
 */
const HANDOVER_MS = 150;

/**
 * How fast elements that each take `durations` at the card's pace are
 * sketched: at that pace, unless it would take longer than `budget` in all.
 */
export function sketchSpeed(durations: readonly number[], budget = SKETCH_BUDGET_MS): number {
  return Math.max(1, sketchMs(durations.map((ms) => ({ ms }))) / budget);
}

/** What the canvas's pencil sound control shows: it shows while a sketch plays, on or muted. */
export interface SketchSound {
  playing: boolean;
  on: boolean;
}

/** The pencil sound control's state, for the canvas controls to read. */
export function createSketchSoundStore(on: boolean) {
  let current: SketchSound = { playing: false, on };
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next: SketchSound) {
      if (next.playing === current.playing && next.on === current.on) return;
      current = next;
      for (const listener of listeners) listener();
    },
  };
}

export type SketchSoundStore = ReturnType<typeof createSketchSoundStore>;

/** What the sketch reads of an element: Excalidraw's own, as the canvas has it. */
export interface SketchElement {
  id: string;
  type: string;
  containerId?: string | null;
  boundElements?: readonly { id: string; type: string }[] | null;
}

/** The canvas a sketch draws over (DrawingCanvas). */
export interface SketchCanvas<E extends SketchElement> {
  /** The element the sketch goes in: over the canvas and the same size. */
  host: HTMLElement;
  /** The canvas's own drawing surface, which the sketch lines up with. */
  surface: () => Element | null;
  /** The scene's elements as the canvas has them now, the arriving ones hidden. */
  elements: readonly E[];
  /** The arriving elements' ids in the order they come in, with the opacity each ends at. */
  arriving: ReadonlyMap<string, number>;
  /** Excalidraw's SVG export of these elements, with `padding` around them. */
  exportSvg: (elements: readonly E[], padding: number) => Promise<SVGSVGElement>;
  /** Excalidraw's bounds of these elements, [minX, minY, maxX, maxY], which its export starts from. */
  bounds: (elements: readonly E[]) => readonly [number, number, number, number];
  /** The canvas's scroll and zoom now, and whether it is dark. */
  view: () => { scrollX: number; scrollY: number; zoom: number; dark: boolean };
  /** Shows these arriving elements on the canvas at their own opacity: before the next paint when `now`. */
  reveal: (ids: readonly string[], now: boolean) => void;
  /** How long after now the first element starts, in ms (the view moves to them first). */
  delay: number;
  /**
   * Puts the view where its move to them ends, before the next paint, and
   * ends what is left of the move; null when the view does not move. The
   * move's steps reach the canvas only as React gets to them, so a frame
   * that shows none does not mean the view is there.
   */
  arrive: (() => void) | null;
  /** The pencil, or null where it stays silent. */
  pen: () => Pencil | null;
  /** The sketch ended: every element is on the canvas, or it was stopped. */
  onDone: () => void;
}

export interface Sketch {
  /**
   * Shows what is left on the canvas at once and ends (the person started
   * working on it): before the next paint when `now` (not from a React
   * effect, where it cannot be).
   */
  finish: (now?: boolean) => void;
  /** Ends without showing anything: the canvas is about to show the elements itself. */
  stop: () => void;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const LINES = new Set(['arrow', 'line']);

/**
 * An element to sketch: its picture over the canvas (none when it only
 * appears), its parts, how long it takes, its animations still running, and
 * whether it is see-through (its sketch over the canvas's copy would show
 * darker, so it goes at once).
 */
type Item = { id: string; type: string; g: SVGGElement | null; steps: Step[]; ms: number; running: number; seeThrough: boolean };

/**
 * What to export to draw an element as the canvas does, and which of the
 * export's pictures are that element's: an arrow's label goes with its arrow,
 * which places it, and an arrow goes with its label, which cuts it.
 */
function exportPlan<E extends SketchElement>(element: E, byId: ReadonlyMap<string, E>): { elements: E[]; keep: 'all' | 'last' | 'before-last' } {
  const container = element.type === 'text' && element.containerId ? byId.get(element.containerId) : undefined;
  if (container && LINES.has(container.type)) return { elements: [container, element], keep: 'last' };
  const bound = LINES.has(element.type) ? element.boundElements?.find((candidate) => candidate.type === 'text') : undefined;
  const label = bound ? byId.get(bound.id) : undefined;
  if (label) return { elements: [element, label], keep: 'before-last' };
  return { elements: [element], keep: 'all' };
}

/**
 * The space the export leaves around the bounds, as the app's own export
 * does: an arrowhead's dot can reach past them, and an arrow's label mask
 * starts at the picture's edge.
 */
const EXPORT_PADDING = 10;

/**
 * The element's picture from its export, placed in the scene; null when it
 * cannot be drawn here as the canvas draws it. The export's pictures start
 * EXPORT_PADDING before its bounds' top left, and each label is one
 * picture, drawn after its arrow's. The element's opacity goes on the whole
 * picture, as the canvas draws it: the export puts it on each part, which
 * shows darker where they cross.
 */
function pictureOf(svg: SVGSVGElement, keep: 'all' | 'last' | 'before-last', [minX, minY, maxX, maxY]: readonly [number, number, number, number], opacity: number): SVGGElement | null {
  // A size other than the bounds' means the export drew more (a frame's name, say): it would not line up.
  const size = (svg.getAttribute('viewBox') ?? '').trim().split(/\s+/).map(Number);
  const width = maxX - minX + EXPORT_PADDING * 2;
  const height = maxY - minY + EXPORT_PADDING * 2;
  if (size.length !== 4 || !(Math.abs(size[2] - width) < 0.01 && Math.abs(size[3] - height) < 0.01)) return null;
  // Labels cut their arrows as the canvas does, under mask ids of their own.
  repairNativeSvgMasks(svg);
  const defs = svg.querySelector(':scope > defs');
  defs?.querySelector('style')?.remove();
  const pictures = [...svg.children].filter((child) => child.localName !== 'defs' && child.localName !== 'metadata');
  const label = pictures.at(-1);
  if (keep !== 'all' && !label?.querySelector('text')) return null;
  const kept = keep === 'all' ? pictures : keep === 'last' ? pictures.slice(-1) : pictures.slice(0, -1);
  if (kept.length === 0) return null;
  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('transform', `translate(${minX - EXPORT_PADDING} ${minY - EXPORT_PADDING})`);
  const picture = document.createElementNS(SVG_NS, 'g');
  if (opacity < 100) picture.setAttribute('opacity', String(Math.max(0, opacity) / 100));
  if (defs && defs.childElementCount > 0) picture.append(defs);
  picture.append(...kept);
  for (const part of picture.querySelectorAll('[stroke-opacity], [fill-opacity]')) {
    part.removeAttribute('stroke-opacity');
    part.removeAttribute('fill-opacity');
  }
  g.append(picture);
  return g;
}

/**
 * Sketches the arriving elements over the canvas, one after another, and
 * shows each on the canvas once it is drawn. The canvas must keep them
 * hidden until `reveal` shows them.
 */
export function sketchIn<E extends SketchElement>(canvas: SketchCanvas<E>): Sketch {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.dataset.sketch = '';
  svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;overflow:hidden;pointer-events:none';
  const camera = document.createElementNS(SVG_NS, 'g');
  svg.append(camera);
  canvas.host.append(svg);

  const queue: Item[] = [];
  // Started and not yet on the canvas; and sketches fading over the canvas's copy.
  const drawing = new Set<Item>();
  const leaving = new Set<SVGGElement>();
  const running = new Set<Animation>();
  const shown = new Set<string>();
  let speed = 1;
  let nextAt = performance.now() + canvas.delay;
  let lastStroke = -Infinity;
  let frame = 0;
  let ended = false;
  let placed = '';
  let filter = '';

  /**
   * The sketch where the canvas draws: its scroll and zoom from the canvas
   * surface's top left, through its dark filter. True when the view moved.
   */
  const follow = () => {
    const { scrollX, scrollY, zoom, dark } = canvas.view();
    const surface = canvas.surface()?.getBoundingClientRect();
    const box = canvas.host.getBoundingClientRect();
    const [left, top] = surface ? [surface.left - box.left, surface.top - box.top] : [0, 0];
    const transform = `translate(${left} ${top}) scale(${zoom}) translate(${scrollX} ${scrollY})`;
    const next = dark ? DARK_FILTER : '';
    if (next !== filter) svg.style.filter = filter = next;
    if (transform === placed) return false;
    camera.setAttribute('transform', (placed = transform));
    return true;
  };

  /** These go on the canvas, before the next paint, and their sketches fade over them. */
  const land = (items: readonly Item[]) => {
    const ids = items.map((item) => item.id).filter((id) => !shown.has(id));
    for (const id of ids) shown.add(id);
    if (ids.length > 0) canvas.reveal(ids, true);
    for (const item of items) {
      drawing.delete(item);
      const g = item.g;
      if (!g) continue;
      if (item.seeThrough) {
        g.remove();
        continue;
      }
      g.dataset.landed = '';
      leaving.add(g);
      const fade = g.animate([{ opacity: 1 }, { opacity: 0 }], { duration: HANDOVER_MS, easing: 'ease-out', fill: 'forwards' });
      running.add(fade);
      fade.onfinish = fade.oncancel = () => {
        running.delete(fade);
        leaving.delete(g);
        g.remove();
      };
    }
  };

  const end = () => {
    ended = true;
    cancelAnimationFrame(frame);
    for (const animation of [...running]) animation.cancel();
    running.clear();
    svg.remove();
    canvas.onDone();
  };

  let arrive = canvas.arrive;

  const tick = (now: number) => {
    frame = 0;
    // When the first element is due, the view goes where it was going.
    if (arrive && queue.length > 0 && now >= nextAt) {
      arrive();
      arrive = null;
    }
    // An element starts once the view holds still, so it is drawn where it lands.
    const moving = follow();
    while (queue.length > 0 && now >= nextAt && !moving) {
      const item = queue.shift()!;
      let ms = 0;
      if (item.g) {
        item.g.style.opacity = '';
        ms = playSteps(item.steps, speed, (animation, done) => {
          running.add(animation);
          item.running += 1;
          animation.onfinish = () => {
            running.delete(animation);
            item.running -= 1;
            done?.();
          };
          animation.oncancel = () => running.delete(animation);
        });
        const pen = canvas.pen();
        if (pen && now - lastStroke >= STROKE_GAP_MS) {
          lastStroke = now;
          pen.stroke(item.type, ms);
        }
      }
      drawing.add(item);
      // The next element starts when this one is most of the way drawn.
      nextAt = Math.max(nextAt, now - 32) + ms * NEXT_AT;
    }
    // Each one drawn goes on the canvas.
    land([...drawing].filter((item) => item.running === 0));
    if (queue.length > 0 || drawing.size > 0 || leaving.size > 0) frame = requestAnimationFrame(tick);
    else end();
  };

  // Each element's picture, in the order they come in, from the canvas's elements at their own opacity.
  const byId = new Map(canvas.elements.map((element) => [element.id, element]));
  const own = (element: E): E => {
    const opacity = canvas.arriving.get(element.id);
    return opacity === undefined ? element : { ...element, opacity };
  };
  const pictures = [...canvas.arriving.keys()].map(async (id) => {
    const element = byId.get(id);
    if (!element) return null;
    const plan = exportPlan(element, byId);
    const elements = plan.elements.map(own);
    try {
      const svg = await canvas.exportSvg(elements, EXPORT_PADDING);
      return { id, type: element.type, g: pictureOf(svg, plan.keep, canvas.bounds(elements), canvas.arriving.get(id) ?? 100) };
    } catch {
      // It appears when its turn comes.
      return { id, type: element.type, g: null };
    }
  });
  void Promise.all(pictures).then((drawn) => {
    if (ended) return;
    for (const picture of drawn) {
      if (!picture) continue;
      const { id, type, g } = picture;
      let steps: Step[] = [];
      if (g) {
        g.dataset.sketchId = id;
        g.style.opacity = '0';
        camera.append(g);
        steps = stepsOf(g);
      }
      queue.push({ id, type, g, steps, ms: itemMs(steps), running: 0, seeThrough: (canvas.arriving.get(id) ?? 100) < 100 });
    }
    speed = sketchSpeed(queue.map((item) => item.ms));
    follow();
    frame = requestAnimationFrame(tick);
  });

  return {
    finish(now = true) {
      if (ended) return;
      // Every one not on the canvas yet, including those whose pictures are still being made.
      const left = [...canvas.arriving.keys()].filter((id) => !shown.has(id));
      for (const id of left) shown.add(id);
      if (left.length > 0) canvas.reveal(left, now);
      end();
    },
    stop() {
      if (!ended) end();
    },
  };
}
