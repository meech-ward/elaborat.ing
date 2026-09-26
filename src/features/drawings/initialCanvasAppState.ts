/** Native initial tool preferences; never applied to existing elements. */
export function initialCanvasAppState(appState?: Record<string, unknown>): Record<string, unknown> {
  return { currentItemFontFamily: 5, currentItemRoundness: 'round', ...appState };
}
