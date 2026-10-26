import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { PREVIEW_SANDBOX, type ParentMessage } from '../features/rendered/protocol';
import type { DocumentEmbedState } from '../features/rendered/documentEmbeds';
import { postLinkToParent, postToParent } from './parentPort';

type Entry = { srcdoc?: string; state: DocumentEmbedState };
let context = { session: '', revision: -1 };
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
const EMPTY: Entry = { state: {} };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export function setDocumentEmbedContext(session: string, revision: number): void {
  context = { session, revision };
}
export function receiveDocumentEmbed(message: Extract<ParentMessage, {kind:'document-embed-bootstrap'|'document-embed-state'}>): void {
  if (message.session !== context.session) return;
  const previous = entries.get(message.id) ?? EMPTY;
  if (message.kind === 'document-embed-bootstrap') {
    entries.set(message.id, {...previous, srcdoc: message.srcdoc});
  } else entries.set(message.id, {...previous, state: {...previous.state, ...message.state}});
  for (const listener of listeners) listener();
}

/** A shell only: the app owns this file's source, history, permissions and editor. */
export function DocumentEmbed({src, title, defaultCollapsed = false, from}: {
  src?: string; title?: string; defaultCollapsed?: boolean; from?: number;
}) {
  const id = useId();
  const region = useId();
  const [expanded, setExpanded] = useState(!defaultCollapsed);
  const [opened, setOpened] = useState(!defaultCollapsed);
  const frame = useRef<HTMLIFrameElement>(null);
  const entry = useSyncExternalStore(subscribe, () => entries.get(id) ?? EMPTY);
  const state = entry.state;
  const valid = typeof src === 'string' && typeof from === 'number' && Number.isSafeInteger(from);
  useEffect(() => {
    if (!opened || !expanded || !valid) return;
    postToParent({kind:'document-embed-open', ...context, id, path:src, from});
  }, [opened, expanded, valid, id, src, from]);
  useEffect(() => () => {
    postToParent({kind:'document-embed-release', ...context, id});
    entries.delete(id);
  }, [id]);
  const action = (next: 'open'|'run'|'save') => {
    const message = {kind:'document-embed-action', ...context, id, action:next};
    postLinkToParent(message);
  };
  return <section className="document-embed" data-document-embed={src} contentEditable={false}>
    <div className="document-embed-header">
      <button type="button" className="document-embed-toggle" aria-expanded={expanded} aria-controls={region}
        onClick={() => {setExpanded(!expanded);setOpened(true);}}>
        <span aria-hidden="true">{expanded ? '▾' : '▸'}</span> {title || src || 'Document'}
      </button>
      {title && src ? <span className="document-embed-path">{src}</span> : null}
      {state.dirty ? <span className="document-embed-status">Unsaved</span> : null}
      {opened ? <button type="button" onClick={event => {if (event.nativeEvent.isTrusted) action('open');}}>Open separately</button> : null}
      {opened && !state.readOnly ? <button type="button" disabled={!state.dirty || state.pending} onClick={event => {if (event.nativeEvent.isTrusted) action('save');}}>Save document</button> : null}
    </div>
    <div id={region} hidden={!expanded} className="document-embed-body">
      {!valid ? <p role="status">Use a literal project Markdown or MDX file path.</p> : null}
      {state.error ? <p role="status" className="document-embed-error">{state.error}</p> : null}
      {state.needsCodeConsent ? <div className="document-embed-consent"><p>This document contains code. Review it separately or run it here.</p><button type="button" onClick={event => {if (event.nativeEvent.isTrusted) action('run');}}>Run document</button></div> : null}
      {valid && !entry.srcdoc && !state.error ? <p role="status">Loading document…</p> : null}
      {entry.srcdoc ? <iframe ref={frame} title={`Embedded document: ${title || src}`} sandbox={PREVIEW_SANDBOX}
        srcDoc={entry.srcdoc} scrolling="no" style={{height:state.height ?? 160, display:state.error || state.needsCodeConsent ? 'none' : 'block'}} /> : null}
    </div>
  </section>;
}
