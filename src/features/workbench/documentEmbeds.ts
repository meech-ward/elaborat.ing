import { isDocumentPath } from "../document/documentPaths";
import { MAX_DOCUMENT_EMBED_DEPTH, type DocumentEmbedHost, type DocumentEmbedState } from "../rendered/documentEmbeds";
import type { OpenTab, TabFile } from "./tabs";

export interface EmbeddedDocumentView {
  id: string;
  owner: string;
  path: string;
  ancestors: readonly string[];
  frame: Window;
  frameScriptUrl?: string;
  onState: (state: DocumentEmbedState) => void;
}

export interface EmbeddedDocumentSession {
  save: () => Promise<boolean>;
  run: () => void;
}

type PooledFile = TabFile & { generation?: number; replacementEpoch: number };
interface EmbedSnapshot {
  files: readonly PooledFile[];
  views: readonly EmbeddedDocumentView[];
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * The trusted project's registry. A path has one editing session even when it
 * appears in several frames or opens as a tab. Only expanded, source-declared
 * references reach attach; no file contents or storage API enter an iframe.
 */
export class DocumentEmbedSessions {
  private files = new Map<string, PooledFile>();
  private views = new Map<string, EmbeddedDocumentView>();
  private hosts = new Map<string, DocumentEmbedHost>();
  private visibleTabs = new Map<string, OpenTab>();
  private states = new Map<string, DocumentEmbedState>();
  private sessions = new Map<string, EmbeddedDocumentSession>();
  private loading = new Map<string, Promise<void>>();
  private epochs = new Map<string, number>();
  private listeners = new Set<() => void>();
  private current: EmbedSnapshot = { files: [], views: [] };

  constructor(
    private readonly read: (path: string) => Promise<TabFile>,
    private open: (path: string) => void = () => {},
  ) {}

  setOpen(open: (path: string) => void): void { this.open = open; }

  snapshot = (): EmbedSnapshot => this.current;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private changed(): void {
    this.current = { files: [...this.files.values()], views: [...this.views.values()] };
    for (const listener of this.listeners) listener();
  }

  /** Open tabs join the pool without replacing an existing draft or history. */
  retainTabs(tabs: readonly OpenTab[]): void {
    let changed = false;
    const visible = new Map<string, OpenTab>();
    for (const tab of tabs) {
      if (!isDocumentPath(tab.path)) continue;
      visible.set(tab.path, tab);
      const existing = this.files.get(tab.path);
      const previous = this.visibleTabs.get(tab.path);
      // Opening a normal tab joins the live session. Explicit generation
      // transitions are document replacements (an assistant edit or a move's
      // rewritten source), even if a newly opened tab reuses an old number.
      const replacement = existing && tab.generation !== undefined &&
        (!previous || previous.generation !== tab.generation);
      if (existing && !replacement) continue;
      this.files.set(tab.path, { ...tab, replacementEpoch: existing ? existing.replacementEpoch + 1 : 0 });
      if (existing) this.states.delete(tab.path);
      changed = true;
    }
    this.visibleTabs = visible;
    if (changed) this.changed();
  }

  host(owner: string): DocumentEmbedHost {
    let host = this.hosts.get(owner);
    if (host) return host;
    host = {
      attach: request => {
        const view: EmbeddedDocumentView = { ...request, owner };
        if (!isDocumentPath(request.path)
          || request.ancestors.length < 2 || request.ancestors.length > MAX_DOCUMENT_EMBED_DEPTH
          || request.ancestors.at(-2) !== owner || request.ancestors.at(-1) !== request.path
          || new Set(request.ancestors).size !== request.ancestors.length) {
          request.onState({ error: "Choose a Markdown or MDX document in this project without a circular reference.", pending: false });
          return () => {};
        }
        if (this.views.size >= 64) {
          request.onState({ error: "Too many embedded documents are open. Remove another reference or reopen the project before opening this one.", pending: false });
          return () => {};
        }
        if (this.views.has(request.id)) {
          request.onState({ error: "This embedded document is already attached.", pending: false });
          return () => {};
        }
        this.views.set(request.id, view);
        const state = this.states.get(request.path);
        request.onState(state ?? { pending: !this.files.has(request.path), error: null });
        this.changed();
        void this.load(request.path);
        return () => {
          if (this.views.get(request.id) !== view) return;
          this.views.delete(request.id);
          this.changed();
        };
      },
      action: (id, action) => {
        const view = this.views.get(id);
        if (!view || view.owner !== owner) return;
        if (action === "open") this.open(view.path);
        else if (action === "run") this.sessions.get(view.path)?.run();
        else void this.saveTree(view.path).then(failures => {
          if (failures.length) view.onState({ error: failures.join(" "), pending: false });
        });
      },
    };
    this.hosts.set(owner, host);
    return host;
  }

  private async load(path: string): Promise<void> {
    if (this.files.has(path)) return;
    const pending = this.loading.get(path);
    if (pending) return pending;
    const epoch = this.epochs.get(path) ?? 0;
    const load = (async () => {
      try {
        if (this.files.size >= 128) throw new Error("Too many documents are open. Close and reopen the project before expanding more.");
        const file = await this.read(path);
        // A tab may have opened while the read was in flight. Its canonical
        // session, including unsaved edits, wins over this initial copy.
        if ((this.epochs.get(path) ?? 0) === epoch && !this.files.has(path)) {
          this.files.set(path, { ...file, replacementEpoch: 0 });
          this.changed();
        }
      } catch (error) {
        if ((this.epochs.get(path) ?? 0) === epoch) this.publish(path, { error: `Cannot open ${path}: ${message(error)}`, pending: false });
      }
    })();
    this.loading.set(path, load);
    try { await load; } finally { this.loading.delete(path); }
  }

  register(path: string, session: EmbeddedDocumentSession): () => void {
    this.sessions.set(path, session);
    return () => { if (this.sessions.get(path) === session) this.sessions.delete(path); };
  }

  publish(path: string, state: DocumentEmbedState): void {
    const previous = this.states.get(path);
    if (previous && JSON.stringify(previous) === JSON.stringify(state)) return;
    this.states.set(path, state);
    for (const view of this.views.values()) if (view.path === path) view.onState(state);
    this.changed();
  }

  replacementEpoch(path: string): number { return this.files.get(path)?.replacementEpoch ?? 0; }

  /** A newly opened tab takes the live session's status, never its stale initial read. */
  dirty(path: string): boolean | undefined {
    const state = this.states.get(path);
    return state ? Boolean(state.dirty || state.pending || this.descendantsDirty(path)) : undefined;
  }

  isEmbedded(path: string): boolean {
    return [...this.views.values()].some(view => view.path === path);
  }

  /** A normal tab can close while its shared embedded draft remains open. */
  forget(path: string): void {
    this.epochs.set(path, (this.epochs.get(path) ?? 0) + 1);
    this.files.delete(path);
    this.states.delete(path);
    for (const view of this.views.values()) {
      if (view.path === path) view.onState({ error: `${path} is not in this project.`, pending: false, readOnly: true });
    }
    this.changed();
  }

  /** Clean sessions whose files moved or disappeared stop serving stale bytes. */
  reconcilePaths(paths: readonly string[]): void {
    const available = new Set(paths);
    for (const file of this.files.values()) {
      const state = this.states.get(file.path);
      if (file.revision !== null && !available.has(file.path) && !state?.dirty && !state?.pending) this.forget(file.path);
    }
  }

  /** Files without tabs still participate in move, delete and leave guards. */
  operationTabs(tabs: readonly OpenTab[]): OpenTab[] {
    const paths = new Set(tabs.map(tab => tab.path));
    return [...tabs, ...this.current.files.filter(file => !paths.has(file.path)).map(file => ({ ...file, dirty: Boolean(this.states.get(file.path)?.dirty) }))];
  }

  descendantsDirty(path: string): boolean {
    const visited = new Set([path]);
    const visit = (current: string): boolean => {
      for (const view of this.views.values()) {
        if (view.owner !== current || visited.has(view.path)) continue;
        visited.add(view.path);
        const state = this.states.get(view.path);
        if (state?.dirty || state?.pending || visit(view.path)) return true;
      }
      return false;
    };
    return visit(path);
  }

  /** Save each loaded descendant once, then its parent, through normal saves. */
  async saveTree(path: string, includeRoot = true): Promise<string[]> {
    const ordered: string[] = [];
    const visited = new Set<string>();
    const visit = (current: string) => {
      if (visited.has(current)) return;
      visited.add(current);
      for (const view of this.views.values()) if (view.owner === current) visit(view.path);
      if (current !== path || includeRoot) ordered.push(current);
    };
    visit(path);
    const failures: string[] = [];
    for (const current of ordered) {
      const state = this.states.get(current);
      if (!state?.dirty && !state?.pending) continue;
      try {
        const session = this.sessions.get(current);
        if (!session || !await session.save()) failures.push(`Could not save ${current}. Open it separately to review its changes.`);
      } catch (error) { failures.push(`Could not save ${current}: ${message(error)}`); }
    }
    return failures;
  }
}
