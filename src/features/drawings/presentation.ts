// What the canvas shows from the app's palette, over the saved scene.
//
// Display only: the canvas shows these colours, but the scene it saves and
// exports keeps the file's own (see DrawingCanvas's `present`).

import type { DrawingScene } from './types.ts';

/** Colours the canvas shows, already adjusted for the dark canvas filter. */
export interface CanvasColors {
  /** Canvas background, unless the file sets its own. */
  background: string;
  /** Stroke for new elements. */
  stroke: string;
}

const DEFAULT_BACKGROUND = /^(#fff|#ffffff|white)$/i;

/**
 * The scene as the canvas shows it: the palette's background, unless the
 * file sets one other than Excalidraw's default white, and the palette's
 * ink for new elements. The scene passed in is not changed.
 */
export function presentDrawing(scene: DrawingScene, colors: CanvasColors): DrawingScene {
  const own = scene.appState?.['viewBackgroundColor'];
  const keepsOwn = typeof own === 'string' && !DEFAULT_BACKGROUND.test(own.trim());
  return {
    ...scene,
    appState: {
      ...scene.appState,
      ...(keepsOwn ? {} : { viewBackgroundColor: colors.background }),
      currentItemStrokeColor: colors.stroke,
    },
  };
}

// Excalidraw's dark theme draws the canvas through
// `filter: invert(93%) hue-rotate(180deg)` (0.18.1, `--theme-filter`).
const INVERT = 0.93;
// hue-rotate(180deg) is 2L - I for the filter's luma weights, its own inverse.
const HUE_180 = [
  [-0.574, 1.43, 0.144],
  [0.426, 0.43, 0.144],
  [0.426, 1.43, -0.856],
] as const;

type Rgb = [number, number, number];

const channel = (value: number) => Math.min(255, Math.max(0, Math.round(value)));
const parse = (hex: string): Rgb => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)) as Rgb;
const format = (rgb: Rgb) => `#${rgb.map((value) => value.toString(16).padStart(2, '0')).join('')}`;
const rotate = (rgb: readonly number[]) => HUE_180.map((row) => row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2]);

function filtered(stored: Rgb): Rgb {
  return rotate(stored.map((value) => INVERT * 255 + (1 - 2 * INVERT) * value)).map(channel) as Rgb;
}

/** What the dark canvas shows for a stored `#rrggbb` colour. */
export function throughDarkFilter(hex: string): string {
  return format(filtered(parse(hex)));
}

/**
 * The `#rrggbb` colour to store so the dark canvas shows `hex`. The filter
 * keeps brightness between about 7% and 93%, so a colour outside that gets
 * the nearest one the filter can show.
 */
export function beforeDarkFilter(hex: string): string {
  const target = parse(hex);
  const miss = (stored: Rgb) => {
    const shown = filtered(stored);
    return Math.max(...shown.map((value, index) => Math.abs(value - target[index])));
  };
  const guess = rotate(target).map((value) => channel((INVERT * 255 - value) / (2 * INVERT - 1))) as Rgb;
  let best = guess;
  let bestMiss = miss(guess);
  const reach = 5;
  for (let r = -reach; r <= reach && bestMiss > 0; r++) {
    for (let g = -reach; g <= reach; g++) {
      for (let b = -reach; b <= reach; b++) {
        const stored: Rgb = [channel(guess[0] + r), channel(guess[1] + g), channel(guess[2] + b)];
        const candidate = miss(stored);
        if (candidate < bestMiss) {
          best = stored;
          bestMiss = candidate;
        }
      }
    }
  }
  return format(best);
}
