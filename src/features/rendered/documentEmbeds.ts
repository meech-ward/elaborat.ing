/** App-owned editing sessions behind opaque, nested document previews. */
export const MAX_DOCUMENT_EMBED_DEPTH = 5;
export const MAX_DOCUMENT_EMBEDS = 16;
export const MAX_DOCUMENT_EMBED_HEIGHT = 2_000_000;

export type DocumentEmbedState = {
  dirty?: boolean;
  pending?: boolean;
  error?: string | null;
  height?: number;
  needsCodeConsent?: boolean;
  readOnly?: boolean;
};

export type DocumentEmbedAction = 'open' | 'run' | 'save';
export type DocumentEmbedHost = {
  attach(request: {
    /** Scoped to the owning RenderedEditor's random session. */
    id: string;
    /** Trusted renderer session that owns this retained view. */
    ownerSession?: string;
    visible?: boolean;
    path: string;
    ancestors: readonly string[];
    frame: Window;
    /** Trusted engine URL inherited from a hosted owner; absent for offline inline frames. */
    frameScriptUrl?: string;
    onState: (state: DocumentEmbedState) => void;
  }): () => void;
  action(id: string, action: DocumentEmbedAction): void;
  /** Suspend retained children without releasing their drafts, frames or ports. */
  setActive?(session: string, active: boolean): void;
  setVisible?(id: string, visible: boolean): void;
};

/** Passed only in trusted preview bootstrap HTML, never in document source. */
export type DocumentFrameBootstrap = {
  ancestor: number;
  nonce: string;
  /** Distinct, human-readable landmark name, capped at 1024 UTF-16 code units. */
  label?: string;
};
