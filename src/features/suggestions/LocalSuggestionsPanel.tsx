import { Button } from "@/components/ui/button";
import type { LocalReviewSnapshot } from "./session";
import type { ReviewAnnotation } from "./review";
import "./suggestions.css";

function Annotation({ annotation }: { annotation: ReviewAnnotation }) {
  const labels: Record<string, string> = {
    ins: "Inserted text", insertion: "Inserted text", del: "Deleted text", deletion: "Deleted text",
    replacement: "Replacement", rPrChange: "Text formatting", pPrChange: "Paragraph formatting",
    formatting: "Formatting", comment: "Comment", moveFrom: "Moved text", moveTo: "Moved text",
  };
  return <li>
    <p><strong>{labels[annotation.kind] ?? "Document revision"}</strong>
      {annotation.author ? ` · ${annotation.author}` : ""}{annotation.date ? ` · ${annotation.date}` : ""}</p>
    {annotation.text && <p className="local-suggestion-record-text">{annotation.text}</p>}
    {annotation.anchor?.quote && <blockquote className="local-suggestion-record-text">{annotation.anchor.quote}</blockquote>}
    <details>
      <summary>Original document details</summary>
      <p>{annotation.kind}{annotation.sourceId ? ` · Original revision ${annotation.sourceId}` : ""}</p>
      {annotation.anchor && <p>Original anchor ({annotation.anchor.projection}, {annotation.anchor.from}–{annotation.anchor.to})</p>}
      {annotation.locator && <p className="local-suggestion-record-text">{annotation.locator}</p>}
      {annotation.rawXml && <pre className="local-suggestion-record-text">{annotation.rawXml}</pre>}
    </details>
  </li>;
}

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
  const annotations = review.provenance?.annotations ?? [];
  const importedById = new Map(annotations.map(annotation => [annotation.id, annotation]));
  const comments = annotations.filter(annotation => annotation.kind === "comment");
  const revisions = annotations.filter(annotation => annotation.kind !== "comment");
  const revisionIds = new Set(revisions.flatMap(annotation => annotation.sourceId ? [annotation.sourceId] : []));
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
    {review.provenance && <details className="local-suggestion-provenance">
      <summary>{review.provenance.label}: {revisionIds.size} {revisionIds.size === 1 ? "revision" : "revisions"} and {comments.length} {comments.length === 1 ? "comment" : "comments"}</summary>
      <p>{count} pending {count === 1 ? "change" : "changes"}. Original revisions can share a pending change. Formatting within inserted text is reviewed with that text.</p>
      <p>These imported comments and revision details stay with this local review.</p>
      <ul>{annotations.map(annotation => <Annotation key={annotation.id} annotation={annotation} />)}</ul>
    </details>}
    {count === 0 ? <p>Type in Source or Rendered to propose a change.</p> : <ul className="local-suggestions-list">
      {review.suggestions.map((suggestion, index) => <li key={suggestion.id} className="local-suggestion">
        <div className="local-suggestion-heading">
          <span>Suggestion {index + 1}</span>
          <Button size="sm" variant="link" disabled={busy} onClick={() => onReveal(suggestion.id)}>Show in source</Button>
        </div>
        {suggestion.sourceIds?.length ? <details>
          <summary>Import details{suggestion.edited ? ", edited after import" : ""}</summary>
          <ul>{suggestion.sourceIds.map(id => {
            const annotation = importedById.get(id);
            return annotation ? <Annotation key={id} annotation={annotation} /> : null;
          })}</ul>
        </details> : null}
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
