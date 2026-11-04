export type SavedFocusHandoff = {id: number; capture: boolean};

/** A temporary read-only preparation handoff may blur contenteditable. Only
 * its matching ready render can return focus; any user action cancels it. */
export class SavedFocusLease {
  private lease: {session: string; id: number} | null = null;

  prepare(session: string, handoff: SavedFocusHandoff | undefined, focused: boolean): void {
    if (!handoff || this.lease && (this.lease.session !== session || this.lease.id !== handoff.id))
      this.lease = null;
    if (handoff?.capture && focused) this.lease = {session,id:handoff.id};
  }

  cancel(): void {this.lease = null;}

  take(session: string, handoff: SavedFocusHandoff | undefined): boolean {
    const restore = handoff !== undefined && !handoff.capture &&
      this.lease?.session === session && this.lease.id === handoff.id;
    this.lease = null;
    return restore;
  }
}
