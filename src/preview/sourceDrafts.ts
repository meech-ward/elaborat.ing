import type { ChildMessage } from '../features/rendered/protocol';

export type DraftRegion = { from: number; to: number; expected: string };
export type DraftValue = { value: string; start: number; end: number; focused: boolean };
export type EditAck = { fromRevision: number; draftId?: number; patches: { from: number; to: number; insertLength: number }[] };
export type DraftSlot = { index: number; element: string; supported: boolean };
type RangeEdit = Extract<ChildMessage, { kind: 'prose-edit' | 'prop-edit' }>;
type ComponentEdit = Extract<ChildMessage, { kind: 'component-value-edit' }>;
type Edit = RangeEdit | ComponentEdit;
type Draft = DraftRegion & DraftValue & { baseline: string };
type Pending = { message: Edit & { draftId: number }; submittedValue?: string; componentElement?: string; region?: DraftRegion };
const key = (region: DraftRegion) => `${region.from}:${region.to}:${region.expected}`;
const regionOf = (message: Edit): DraftRegion | undefined => 'from' in message ? message : undefined;
const pendingRegion = (pending: Pending): DraftRegion | undefined => pending.region ?? regionOf(pending.message);

/** Coordinates are in the old source. Overlap never grants a new edit range. */
export function rebaseDraftRegion(region: DraftRegion, patches: EditAck['patches']): DraftRegion | null {
  let shift = 0;
  for (const patch of patches) {
    if (patch.to <= region.from) shift += patch.insertLength - (patch.to - patch.from);
    else if (patch.from < region.to) return null;
  }
  return { ...region, from: region.from + shift, to: region.to + shift };
}

/** Drafts are not authority. Only fresh compiled regions release rebased edits. */
export class SourceDraftStore {
  private session = '';
  private revision = -1;
  private drafts = new Map<string, Draft>();
  private pending: Pending[] = [];
  private flight: Pending | null = null;
  private rendering = false;
  private nextDraftId = 0;
  private slots: readonly DraftSlot[] = [];
  readonly recovery: { value: string; reason: string }[] = [];

  constructor(private readonly send: (message: Edit) => void, private readonly pendingChanged: (pending: boolean) => void = () => {}) {}

  capture(region: DraftRegion, draft: DraftValue, baseline: string) {
    if (draft.value === baseline && !draft.focused) this.drafts.delete(key(region));
    else this.drafts.set(key(region), { ...region, ...draft, baseline });
  }

  get(region: DraftRegion): DraftValue | undefined { return this.drafts.get(key(region)); }

  private retain(value: string | undefined, reason: string) {
    if (value !== undefined && !this.recovery.some(item => item.value === value && item.reason === reason))
      this.recovery.push({ value, reason });
  }

  private retainDraft(draft: Draft, reason: string) {
    if (draft.value !== draft.baseline) this.retain(draft.value, reason);
  }

  settle(draftId: number, outcome: 'noop' | 'rejected', reason?: string) {
    if (this.flight?.message.draftId !== draftId) return;
    if (outcome === 'rejected') this.retain(this.flight.submittedValue, reason ?? 'Source refused the edit.');
    else {
      const region = pendingRegion(this.flight), draft = region && this.drafts.get(key(region));
      if (draft && draft.value === this.flight.submittedValue) this.drafts.delete(key(draft));
    }
    this.flight = null;
    this.flush();
  }

  queue(message: Edit, submittedValue?: string, sourceRegion?: DraftRegion) {
    const value = submittedValue ?? ('value' in message ? message.value : undefined);
    if (message.session !== this.session || message.revision !== this.revision) {
      this.retain(value, 'The source changed before this edit could be submitted.');
      return;
    }
    const region = sourceRegion ?? regionOf(message);
    const existing = this.pending.findIndex(item => {
      const other = pendingRegion(item);
      if (region && other) return key(other) === key(region);
      return message.kind === 'component-value-edit' && item.message.kind === 'component-value-edit' && message.slot === item.message.slot && message.prop === item.message.prop;
    });
    const component = message.kind === 'component-value-edit' ? this.slots.find(slot => slot.index === message.slot && slot.supported) : undefined;
    const entry = { message: { ...message, draftId: ++this.nextDraftId }, submittedValue: value, componentElement: component?.element, region: sourceRegion };
    if (existing >= 0) this.pending[existing] = entry;
    else this.pending.push(entry);
    this.flush();
  }

  beginRender(session: string, revision: number, ack?: EditAck, slots: readonly DraftSlot[] = []) {
    this.rendering = true;
    this.slots = slots;
    if (session === this.session && revision === this.revision) return;
    const chained = session === this.session && revision === this.revision + 1 && ack?.fromRevision === this.revision;
    if (!chained || !ack) {
      for (const draft of this.drafts.values()) this.retainDraft(draft, 'A source update interrupted this draft.');
      for (const entry of [...this.pending, ...(this.flight ? [this.flight] : [])])
        this.retain(entry.submittedValue, 'A source update interrupted this draft.');
      this.drafts.clear(); this.pending = []; this.flight = null;
    } else {
      const submitted = this.flight?.message.draftId === ack.draftId ? this.flight : null;
      if (this.flight && !submitted) this.retain(this.flight.submittedValue, 'Another source edit interrupted this submission.');
      const submittedRegion = submitted && pendingRegion(submitted);
      const rebased = new Map<string, Draft>();
      for (const draft of this.drafts.values()) {
        if (submittedRegion && key(draft) === key(submittedRegion) && draft.value === submitted?.submittedValue) continue;
        const region = rebaseDraftRegion(draft, ack.patches);
        if (region) rebased.set(key(region), { ...draft, ...region });
        else this.retainDraft(draft, 'A source change overlaps this draft.');
      }
      this.drafts = rebased;
      this.pending = this.pending.flatMap<Pending>(entry => {
        const message = entry.message;
        if (message.kind === 'component-value-edit') {
          const sameSlot = slots.some(slot => slot.index === message.slot && slot.supported && slot.element === entry.componentElement);
          const literalAck = submitted && !(submitted.message.kind === 'prose-edit' && submitted.message.shortcut);
          const mapped = entry.region && rebaseDraftRegion(entry.region, ack.patches);
          if (sameSlot && literalAck && (!entry.region || mapped)) return [{ ...entry, region: mapped ?? undefined, message: { ...message, revision } }];
          this.retain(entry.submittedValue, 'The component changed before its queued edit could be matched.');
          return [];
        }
        const region = regionOf(entry.message);
        const rebasedRegion = region && rebaseDraftRegion(region, ack.patches);
        if (!rebasedRegion) {
          this.retain(entry.submittedValue, 'This queued edit could not be matched to unchanged source.');
          return [];
        }
        return [{ ...entry, message: { ...entry.message, ...rebasedRegion, revision } as RangeEdit & { draftId: number } }];
      });
      this.flight = null;
    }
    this.session = session; this.revision = revision;
  }

  finishRender(regions: readonly DraftRegion[]) {
    const available = new Set(regions.map(key));
    for (const [id, draft] of this.drafts) {
      if (available.has(id)) continue;
      this.retainDraft(draft, 'The updated document no longer exposes the same editable text.');
      this.drafts.delete(id);
    }
    this.pending = this.pending.filter(entry => {
      const message = entry.message;
      if (message.kind === 'component-value-edit') {
        if ((!entry.region || available.has(key(entry.region))) && this.slots.some(slot => slot.index === message.slot && slot.supported && slot.element === entry.componentElement)) return true;
        this.retain(entry.submittedValue, 'The updated document no longer exposes the same component.');
        return false;
      }
      const region = regionOf(entry.message);
      if (region && available.has(key(region))) return true;
      this.retain(entry.submittedValue, 'The updated document no longer exposes the same editable text.');
      return false;
    });
    this.rendering = false;
    this.flush();
  }

  private flush() {
    this.pendingChanged(!!this.flight || !!this.pending.length);
    if (this.rendering || this.flight || !this.pending.length) return;
    this.flight = this.pending.shift()!;
    this.send(this.flight.message);
  }
}

let browserSession = '', browserRevision = -1;
const store = new SourceDraftStore(
  message => window.parent.postMessage(message, '*'),
  pending => {
    if (browserRevision >= 0) window.parent.postMessage({ kind: 'source-draft-pending', session: browserSession, revision: browserRevision, pending }, '*');
  },
);
const selector = '[data-authoring-from][data-authoring-to][data-authoring-expected][data-authoring-value]';

function regionOfElement(element: HTMLElement): DraftRegion | null {
  const from = Number(element.dataset.authoringFrom), to = Number(element.dataset.authoringTo);
  const expected = element.dataset.authoringExpected;
  return expected !== undefined && Number.isInteger(from) && from >= 0 && Number.isInteger(to) && to >= from ? { from, to, expected } : null;
}

function selectionOf(element: HTMLElement): Pick<DraftValue, 'start' | 'end'> {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)
    return { start: element.selectionStart ?? 0, end: element.selectionEnd ?? 0 };
  const selection = window.getSelection();
  const offset = (node: Node | null, position: number) => {
    if (!node || !element.contains(node)) return 0;
    const range = document.createRange(); range.selectNodeContents(element); range.setEnd(node, position);
    return range.toString().length;
  };
  return { start: offset(selection?.anchorNode ?? null, selection?.anchorOffset ?? 0), end: offset(selection?.focusNode ?? null, selection?.focusOffset ?? 0) };
}

export function captureSourceDraft(element: HTMLElement) {
  const region = regionOfElement(element);
  if (!region) return;
  const value = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : element.textContent ?? '';
  store.capture(region, { value, ...selectionOf(element), focused: document.hasFocus() && document.activeElement === element }, element.dataset.authoringValue ?? '');
}

export function captureDraftsBeforeRender() {
  for (const element of document.querySelectorAll<HTMLElement>(selector))
    if (element.isContentEditable || element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) captureSourceDraft(element);
}

export function getSourceDraft(region: DraftRegion): DraftValue | undefined { return store.get(region); }

/** A focused draft for a region that has just appeared, holding `value` with the caret at its end. */
export function startSourceDraft(region: DraftRegion, value: string, baseline: string) {
  if (!store.get(region)) store.capture(region, { value, start: value.length, end: value.length, focused: true }, baseline);
}

export function restoreSourceDraft(element: HTMLElement) {
  const region = regionOfElement(element), draft = region && store.get(region);
  if (!draft) return;
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    element.value = draft.value;
    if (draft.focused) { element.focus(); element.setSelectionRange(draft.start, draft.end); }
  } else {
    element.textContent = draft.value;
    if (draft.focused) {
      element.focus();
      const node = element.firstChild ?? element.appendChild(document.createTextNode(''));
      window.getSelection()?.setBaseAndExtent(node, Math.min(draft.start, draft.value.length), node, Math.min(draft.end, draft.value.length));
    }
  }
}

export function setSourceDraftContext(session: string, revision: number, ack?: EditAck, slots: readonly DraftSlot[] = []) {
  browserSession = session; browserRevision = revision;
  store.beginRender(session, revision, ack, slots);
}
export function queueRangeEdit(message: RangeEdit, submittedValue?: string) { store.queue(message, submittedValue); renderRecoveryNotice(); }
export function queueComponentValueEdit(message: ComponentEdit, region?: DraftRegion) { store.queue(message, message.value, region); renderRecoveryNotice(); }
export function settleSourceDraft(draftId: number, outcome: 'noop' | 'rejected', reason?: string) { store.settle(draftId, outcome, reason); renderRecoveryNotice(); }

export function finishSourceDraftRender(extraRegions: readonly DraftRegion[] = []) {
  store.finishRender([...extraRegions, ...[...document.querySelectorAll<HTMLElement>(selector)].flatMap(element => {
    const region = regionOfElement(element); return region ? [region] : [];
  })]);
  renderRecoveryNotice();
}

function renderRecoveryNotice() {
  if (!store.recovery.length) return;
  let notice = document.getElementById('source-draft-recovery');
  if (!notice) { notice = document.createElement('details'); notice.id = 'source-draft-recovery'; document.body.appendChild(notice); }
  notice.replaceChildren();
  const title = document.createElement('summary'); title.textContent = 'An edit was interrupted. Recover your retained draft'; notice.appendChild(title);
  for (const draft of store.recovery) {
    const label = document.createElement('p'); label.textContent = draft.reason;
    const text = document.createElement('textarea'); text.readOnly = true; text.value = draft.value; text.setAttribute('aria-label', 'Retained draft');
    notice.append(label, text);
  }
}
