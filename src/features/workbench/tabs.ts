export interface TabFile {
  path: string;
  content: string;
  revision: string | null;
  savedContent?: string | null;
}
export interface OpenTab extends TabFile {
  dirty: boolean;
  generation?: number;
}
export interface TabState {
  tabs: OpenTab[];
  active: string | null;
  sequence: number;
}
export const emptyTabs: TabState = { tabs: [], active: null, sequence: 0 };
export type TabAction =
  | { type: "request"; sequence: number }
  | { type: "opened"; sequence: number; file: TabFile }
  | { type: "restored"; files: TabFile[]; activePath: string | null; activate?: boolean; order?: readonly string[] }
  | { type: "select"; path: string }
  | { type: "reorder"; path: string; target: string; side: "before" | "after" }
  | { type: "dirty"; path: string; dirty: boolean }
  | { type: "close"; path: string; discard: boolean }
  | { type: "move-reconciled"; files: Array<TabFile & { from: string }> }
  | { type: "renamed"; from: string; to: string; content: string; revision: string }
  | { type: "draft-renamed"; from: string; to: string; content: string }
  | { type: "assistant-edit"; file: TabFile };
export function tabTransition(state: TabState, action: TabAction): TabState {
  switch (action.type) {
    case "reorder": {
      const moved = state.tabs.find(tab => tab.path === action.path);
      if (!moved || action.path === action.target || !state.tabs.some(tab => tab.path === action.target)) return state;
      const tabs = state.tabs.filter(tab => tab !== moved);
      const index = tabs.findIndex(tab => tab.path === action.target) + (action.side === "after" ? 1 : 0);
      tabs.splice(index, 0, moved);
      return tabs.every((tab, i) => tab === state.tabs[i]) ? state : { ...state, tabs };
    }
    case "move-reconciled": {
      const replacements = new Map(action.files.map(file => [file.from, file]));
      if (state.tabs.some(tab => replacements.has(tab.path) && tab.dirty)) return state;
      if (action.files.some(file => file.from !== file.path && state.tabs.some(tab => tab.path === file.path && !replacements.has(tab.path)))) return state;
      return {
        ...state,
        active: state.active ? replacements.get(state.active)?.path ?? state.active : null,
        tabs: state.tabs.map(tab => {
          const file = replacements.get(tab.path);
          return file ? { path: file.path, content: file.content, revision: file.revision, dirty: false, generation: (tab.generation ?? 0) + 1 } : tab;
        }),
      };
    }
    case "request":
      return { ...state, sequence: action.sequence };
    case "opened":
      if (action.sequence !== state.sequence) return state;
      return {
        ...state,
        active: action.file.path,
        tabs: state.tabs.some((t) => t.path === action.file.path)
          ? state.tabs
          : [...state.tabs, { ...action.file, dirty: false }],
      };
    case "restored": {
      // Merge remembered files without duplicating tabs the user opened
      // while restoration was in flight. Existing sessions keep identity;
      // the current selection wins when still valid.
      const seen = new Set(state.tabs.map((t) => t.path));
      const tabs = [...state.tabs];
      for (const file of action.files) {
        if (seen.has(file.path)) continue;
        seen.add(file.path);
        tabs.push({ ...file, dirty: false });
      }
      if (action.order) {
        const positions = new Map(action.order.map((path, index) => [path, index]));
        tabs.sort((a, b) => (positions.get(a.path) ?? Infinity) - (positions.get(b.path) ?? Infinity));
      }
      let active = state.active;
      if (action.activate !== false && (active === null || !seen.has(active))) {
        active =
          action.activePath !== null && seen.has(action.activePath)
            ? action.activePath
            : (tabs[tabs.length - 1]?.path ?? null);
      }
      if (tabs.length === state.tabs.length && tabs.every((tab, index) => tab === state.tabs[index]) && active === state.active)
        return state;
      return { ...state, tabs, active };
    }
    case "select":
      return state.tabs.some((t) => t.path === action.path)
        ? { ...state, active: action.path }
        : state;
    case "dirty":
      return state.tabs.some(
        (t) => t.path === action.path && t.dirty !== action.dirty,
      )
        ? {
            ...state,
            tabs: state.tabs.map((t) =>
              t.path === action.path ? { ...t, dirty: action.dirty } : t,
            ),
          }
        : state;
    case "renamed": {
      // Successful rename of a clean open tab: move its identity to
      // the new path with FRESH authoritative bytes from a post-rename read
      // (the open session remounts on the path key). TabFile content and
      // revision are INITIAL read values — retaining them here would show
      // stale content under the new revision after an edit+save — so the
      // action must carry the fresh pair and the old bytes are never
      // reused. Dirty tabs and never-reconciled drafts (revision null: an
      // import or untitled buffer whose bytes are not known to equal the
      // saved file) are refused before dispatch AND here: relabelling
      // either onto fresh saved bytes would discard the buffer. A
      // destination already occupied by another tab (e.g. an unsaved
      // draft) leaves state untouched.
      const tab = state.tabs.find((t) => t.path === action.from);
      if (!tab || tab.dirty || tab.revision === null) return state;
      if (state.tabs.some((t) => t.path === action.to)) return state;
      return {
        ...state,
        tabs: state.tabs.map((t) =>
          t.path === action.from
            ? {
                path: action.to,
                content: action.content,
                revision: action.revision,
                dirty: false,
              }
            : t,
        ),
        active: state.active === action.from ? action.to : state.active,
      };
    }
    case "draft-renamed": {
      // A new file that was never saved took a new name: its tab follows,
      // still unsaved, with the text its draft holds now. The session
      // remounts on the path key and saves under the new name.
      const tab = state.tabs.find((t) => t.path === action.from);
      if (!tab || tab.revision !== null) return state;
      if (state.tabs.some((t) => t.path === action.to)) return state;
      return {
        ...state,
        tabs: state.tabs.map((t) =>
          t.path === action.from
            ? { path: action.to, content: action.content, revision: null, dirty: t.dirty, generation: (t.generation ?? 0) + 1 }
            : t,
        ),
        active: state.active === action.from ? action.to : state.active,
      };
    }
    case "assistant-edit": {
      // The assistant's version of a file, as an unsaved edit over its saved
      // copy: the file's tab opens (or its session remounts with it) and
      // comes forward. The session reports it dirty, as after typing.
      const existing = state.tabs.find((t) => t.path === action.file.path);
      const tab: OpenTab = { ...action.file, dirty: existing?.dirty ?? false, generation: (existing?.generation ?? 0) + 1 };
      return {
        ...state,
        active: action.file.path,
        tabs: existing ? state.tabs.map((t) => (t === existing ? tab : t)) : [...state.tabs, tab],
      };
    }
    case "close": {
      const index = state.tabs.findIndex((t) => t.path === action.path);
      if (index < 0 || (state.tabs[index].dirty && !action.discard))
        return state;
      const tabs = state.tabs.filter((t) => t.path !== action.path);
      return {
        ...state,
        tabs,
        active:
          state.active === action.path
            ? (tabs[Math.min(index, tabs.length - 1)]?.path ?? null)
            : state.active,
      };
    }
  }
}
