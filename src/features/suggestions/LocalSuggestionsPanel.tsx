import { Button } from "@/components/ui/button";
import type { LocalReviewSnapshot } from "./session";
import "./suggestions.css";

export function LocalSuggestionsPanel({ snapshot, stale, disabled, onAccept, onReject, onStop, onKeep, onReveal }: {
  snapshot: LocalReviewSnapshot;
  stale: boolean;
  disabled: boolean;
  onAccept: (id: string | null) => void;
  onReject: (id: string | null) => void;
  onStop: () => void;
  onKeep: () => void;
  onReveal: (id: string) => void;
}) {
  const review = snapshot.review;
  if (!review) return null;
  const count = review.suggestions.length;
  const busy = disabled || snapshot.busy;
  return <section aria-label="Local suggestions" className="local-suggestions">
    <div className="local-suggestions-header">
      <div>
        <h2>Suggesting locally</h2>
        <p>Changes stay on this device until accepted. Accept saves the file.</p>
      </div>
      <div className="local-suggestions-actions">
        <Button size="sm" variant="outline" disabled={busy || stale || !count} onClick={() => onAccept(null)}>Accept all</Button>
        <Button size="sm" variant="outline" disabled={busy || !count} onClick={() => onReject(null)}>Reject all</Button>
        <Button size="sm" variant="ghost" disabled={busy || count > 0} onClick={onStop}>Return to editing</Button>
      </div>
    </div>
    {stale && !snapshot.busy && <p role="alert">The accepted file changed or moved. These suggestions need a new review before acceptance. Export the proposed source to keep a separate copy.</p>}
    {snapshot.error && <p role="alert">{snapshot.error} <Button size="sm" variant="link" onClick={onKeep} disabled={busy}>Try keeping review again</Button></p>}
    <p role="status" className="local-suggestions-status">{snapshot.busy ? "Finishing decision…" : snapshot.keeping ? "Keeping review…" : snapshot.kept ? "Review kept in this browser." : "Review has not been kept. Export the proposed source before leaving."}</p>
    {count === 0 ? <p>Type in Source or Rendered to propose a change.</p> : <ul className="local-suggestions-list">
      {review.suggestions.map((suggestion, index) => <li key={suggestion.id} className="local-suggestion">
        <div className="local-suggestion-heading">
          <span>Suggestion {index + 1}</span>
          <Button size="sm" variant="link" disabled={busy} onClick={() => onReveal(suggestion.id)}>Show in source</Button>
        </div>
        <div className="local-suggestion-text" tabIndex={0} aria-label={`Source changes in suggestion ${index + 1}`}>
          {suggestion.expected && <div><span className="sr-only">Remove: </span><del>{suggestion.expected.slice(0, 4000)}</del>{suggestion.expected.length > 4000 && "…"}</div>}
          {suggestion.insert && <div><span className="sr-only">Add: </span><ins>{suggestion.insert.slice(0, 4000)}</ins>{suggestion.insert.length > 4000 && "…"}</div>}
        </div>
        <div className="local-suggestions-actions">
          <Button size="sm" variant="outline" disabled={busy || stale} onClick={() => onAccept(suggestion.id)}>Accept suggestion</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onReject(suggestion.id)}>Reject suggestion</Button>
        </div>
      </li>)}
    </ul>}
  </section>;
}
