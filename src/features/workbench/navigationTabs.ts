import { emptyTabs, tabTransition, type TabAction, type TabState } from "./tabs";

export type NavigationTabAction = TabAction & { fromLocation?: boolean };
export interface NavigationTabState extends TabState {
  locationVersion: number;
  locationCommand: { version: number; path: string | null; replace: boolean } | null;
}
export const emptyNavigationTabs: NavigationTabState = { ...emptyTabs, locationVersion: 0, locationCommand: null };

/** User/automatic tab transitions emit one URL command. URL reads emit none. */
export function navigationTabTransition(state: NavigationTabState, action: NavigationTabAction): NavigationTabState {
  const next = tabTransition(state, action);
  if (action.fromLocation) return { ...state, ...next, locationCommand: null };
  if (next === state || (next.active === state.active && action.type !== "select" && action.type !== "opened")) return { ...state, ...next };
  const version = state.locationVersion + 1;
  return { ...state, ...next, locationVersion: version, locationCommand: {
    version, path: next.active, replace: action.type !== "opened" && action.type !== "select",
  } };
}
