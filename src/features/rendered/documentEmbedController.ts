import { parseDocumentReferences, type DocumentReference } from '../document/documentReferences';
import { documentEmbedReadySchema, type ChildMessage } from './protocol';
import {
  MAX_DOCUMENT_EMBED_DEPTH, MAX_DOCUMENT_EMBEDS,
  type DocumentEmbedHost, type DocumentEmbedState, type DocumentFrameBootstrap,
} from './documentEmbeds';

type Context = {
  session: string; revision: number; text: string; format: 'md'|'mdx';
  owner: Window | null; path: string; ancestors: readonly string[];
  host?: DocumentEmbedHost;
  frameScriptUrl?: string;
  /**
   * The rendered note's key for its islands' source (the projection's
   * runtimeKey). Every reference is an island, so while the key holds, no
   * reference came or went, whatever else of the text changed.
   */
  referencesKey?: string;
};
type Entry = {
  id: string; path: string; nonce: string; label: string; owner: Window;
  host: DocumentEmbedHost; state: DocumentEmbedState; timer: ReturnType<typeof setTimeout>;
  cleanup?: () => void;
};
type Request = Extract<ChildMessage, {kind:'document-embed-open'|'document-embed-release'|'document-embed-action'}>;
/** Assigned at instance creation, never during render or HTML generation. */
let documentView = 0;
/**
 * The height each embedded document last reported, by path, while this page
 * is open: a new view of it (its note opened again, or it expanded) starts at
 * that height instead of growing from a placeholder once it has loaded.
 */
const reportedHeights = new Map<string, number>();
const MAX_REPORTED_HEIGHTS = 64;
function rememberHeight(path: string, height: number) {
  reportedHeights.delete(path);
  reportedHeights.set(path, height);
  if (reportedHeights.size > MAX_REPORTED_HEIGHTS) reportedHeights.delete(reportedHeights.keys().next().value as string);
}

/** Every capability comes from literal references in app-owned source. */
export class DocumentEmbedController {
  private entries = new Map<string, Entry>();
  private parsed: {text:string;format:'md'|'mdx';refs:DocumentReference[]} | null = null;
  /** The references key (with the format) the open views were last checked against the note's references for. */
  private reconciled: string | null = null;
  constructor(private readonly options: {
    context: () => Context;
    send: (message: unknown) => void;
    nonce: () => string;
    bootstrap: (config: DocumentFrameBootstrap) => Promise<string>;
  }) {}

  private state(id: string, state: DocumentEmbedState) {
    const context = this.options.context();
    const bounded = {...state, ...(typeof state.error === 'string' ? {error:state.error.slice(0, 2000)} : {})};
    this.options.send({kind:'document-embed-state', session:context.session, id, state:bounded});
  }
  private references(context: Context) {
    if (this.parsed?.text === context.text && this.parsed.format === context.format) return this.parsed.refs;
    let refs: DocumentReference[];
    try { refs = parseDocumentReferences(context.text, context.format); }
    catch { refs = []; }
    this.parsed = {text:context.text,format:context.format,refs};
    return refs;
  }
  private release(id: string) {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    clearTimeout(entry.timer);
    entry.cleanup?.();
  }
  dispose() { for (const id of this.entries.keys()) this.release(id); }
  reconcile() {
    // Nothing open, nothing to release: the note is not read for references
    // on every change (an open request reads them when it comes).
    if (!this.entries.size) return;
    const context = this.options.context();
    // Typing that keeps the references key reads nothing.
    const key = context.referencesKey === undefined ? null : `${context.format}:${context.referencesKey}`;
    const refs = key !== null && key === this.reconciled ? null : this.references(context);
    this.reconciled = key;
    for (const [id, entry] of this.entries) {
      if (entry.owner !== context.owner || entry.host !== context.host || (refs && !refs.some(ref => ref.path === entry.path))) this.release(id);
    }
  }

  handle(message: Request, activated = false): void {
    const context = this.options.context();
    if (message.session !== context.session || message.revision !== context.revision) return;
    if (message.kind === 'document-embed-release') { this.release(message.id); return; }
    if (message.kind === 'document-embed-action') {
      if (!activated) return;
      const entry = this.entries.get(message.id);
      if (entry?.cleanup && this.references(context).some(ref => ref.path === entry.path)) entry.host.action(`${context.session}:${entry.id}`, message.action);
      return;
    }
    if (!this.references(context).some(ref => ref.path === message.path && ref.from === message.from)) {
      this.state(message.id, {pending:false,error:'This document is not a literal reference in the current source.'});
      return;
    }
    if (context.ancestors.includes(message.path)) {
      this.state(message.id, {pending:false,error:'This document would create a circular reference.'}); return;
    }
    if (context.ancestors.length >= MAX_DOCUMENT_EMBED_DEPTH) {
      this.state(message.id, {pending:false,error:`Documents can be nested at most ${MAX_DOCUMENT_EMBED_DEPTH - 1} levels.`}); return;
    }
    const previous = this.entries.get(message.id);
    if (previous?.path === message.path) { this.state(message.id, previous.state); return; }
    this.release(message.id);
    if (this.entries.size >= MAX_DOCUMENT_EMBEDS) {
      this.state(message.id, {pending:false,error:`Open at most ${MAX_DOCUMENT_EMBEDS} embedded documents in one document.`}); return;
    }
    if (!context.host || !context.owner) {
      this.state(message.id, {pending:false,error:'Open this document in the project to view its embedded documents.'}); return;
    }
    const entry: Entry = {
      id:message.id, path:message.path, nonce:this.options.nonce(), owner:context.owner, host:context.host,
      label:`Embedded document ${message.path}, view ${++documentView}`,
      state:{pending:true,error:null,...(reportedHeights.has(message.path) ? {height:reportedHeights.get(message.path)} : {})},
      timer:setTimeout(() => {
        if (this.entries.get(message.id) !== entry || entry.cleanup) return;
        this.release(message.id);
        this.state(message.id, {pending:false,error:'The embedded preview could not load. Collapse and expand it to retry.'});
      }, 15_000),
    };
    this.entries.set(message.id, entry);
    this.state(message.id, entry.state);
    void this.options.bootstrap({ancestor:context.ancestors.length + 1, nonce:entry.nonce,label:entry.label}).then(srcdoc => {
      if (this.entries.get(entry.id) !== entry) return;
      this.reconcile();
      if (this.entries.get(entry.id) !== entry) return;
      const latest = this.options.context();
      this.options.send({kind:'document-embed-bootstrap',session:latest.session,revision:latest.revision,id:entry.id,srcdoc});
    }).catch(() => {
      if (this.entries.get(entry.id) !== entry) return;
      this.release(entry.id);
      this.state(entry.id, {pending:false,error:'The embedded preview could not load. Collapse and expand it to retry.'});
    });
  }

  ready(event: Pick<MessageEvent, 'data'|'source'>): void {
    const parsed = documentEmbedReadySchema.safeParse(event.data);
    if (!parsed.success || !event.source) return;
    const entry = [...this.entries.values()].find(value => value.nonce === parsed.data.nonce);
    if (!entry || entry.cleanup) return;
    const frame = event.source as Window;
    try { if (frame.parent !== entry.owner) return; } catch { return; }
    this.reconcile();
    if (this.entries.get(entry.id) !== entry) return;
    clearTimeout(entry.timer);
    const context = this.options.context();
    entry.cleanup = entry.host.attach({id:`${context.session}:${entry.id}`,path:entry.path,
      ancestors:[...context.ancestors, entry.path],frame,frameScriptUrl:context.frameScriptUrl,
      onState:state => {
        if (this.entries.get(entry.id) !== entry) return;
        if (typeof state.height === 'number') rememberHeight(entry.path, state.height);
        entry.state = {...entry.state, ...state};
        this.state(entry.id, entry.state);
      }});
  }
}
