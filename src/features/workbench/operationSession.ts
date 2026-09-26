/** What the workbench asks of each open file before leaving the project or signing out. */
export interface OperationState {
  dirty: boolean;
  pending: boolean;
  saving: boolean;
  reconciled: boolean;
}

export interface OperationSession {
  state: () => OperationState;
  freeze: () => void;
  release: () => void;
  persistDraft?: () => Promise<void>;
}
