import { Button } from "@/components/ui/button";
import type { LocalReviewSnapshot } from "./session";
import type { ReviewAnnotation, ReviewState } from "./review";
import "./suggestions.css";

function Annotation({ annotation }: { annotation: ReviewAnnotation }) {
  const labels: Record<string, string> = {
    ins: "Inserted text", insertion: "Inserted text", del: "Deleted text", deletion: "Deleted text",
    replacement: "Replacement", rPrChange: "Text formatting", pPrChange: "Paragraph formatting",
    formatting: "Formatting", comment: "Comment", moveFrom: "Moved text", moveTo: "Moved text",
  };
  return <li>
    <p><strong>{Object.hasOwn(labels, annotation.kind) ? labels[annotation.kind] : "Document revision"}</strong>
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

export function OriginalReviewDetails({ review, completed = false }: { review: ReviewState; completed?: boolean }) {
  const annotations = review.provenance?.annotations ?? [];
  const comments = annotations.filter(annotation => annotation.kind === "comment");
  const revisionIds = new Set(annotations.filter(annotation => annotation.kind !== "comment").flatMap(annotation => annotation.sourceId ? [annotation.sourceId] : []));
  return review.provenance ? <details className="local-suggestion-provenance">
    <summary>{review.provenance.label}: {revisionIds.size} {revisionIds.size === 1 ? "revision" : "revisions"} and {comments.length} {comments.length === 1 ? "comment" : "comments"}</summary>
    <p>{review.suggestions.length} {completed ? "original" : "pending"} {review.suggestions.length === 1 ? "change" : "changes"}. Original revisions can share a change. Formatting within inserted text is reviewed with that text.</p>
    <p>Original comments and revision details remain with this review.</p>
    <ul>{annotations.map(annotation => <Annotation key={annotation.id} annotation={annotation} />)}</ul>
  </details> : null;
}

export function LocalSuggestionsPanel({ snapshot, stale, disabled, readOnly = false, onAccept, onReject, onStop, onKeep, onReload, onReveal }: {
  snapshot: LocalReviewSnapshot;
  stale: boolean;
  disabled: boolean;
  readOnly?: boolean;
  onAccept: (id: string | null) => void;
  onReject: (id: string | null) => void;
  onStop: () => void;
  onKeep: () => void;
  onReload?: () => void;
  onReveal: (id: string) => void;
}) {
  const review = snapshot.review;
  if (!review) return null;
  const count = review.suggestions.length;
  const busy = disabled || snapshot.busy;
  const shared = snapshot.durability === "server";
  const cannotDecide = busy || readOnly;
  const annotations = review.provenance?.annotations ?? [];
  const importedById = new Map(annotations.map(annotation => [annotation.id, annotation]));
  return <section aria-label={shared ? "Suggestions" : "Local suggestions"} className="local-suggestions">
    <div className="local-suggestions-header">
      <div>
        <h2>{shared ? "Suggesting" : "Suggesting locally"}</h2>
        <p>{shared ? "Suggestions are shared with this project. Accept saves the file." : "Changes stay on this device until accepted. Accept saves the file."}</p>
      </div>
      <div className="local-suggestions-actions">
        <Button size="sm" variant="outline" disabled={cannotDecide || stale || !count} onClick={() => onAccept(null)}>Accept all</Button>
        <Button size="sm" variant="outline" disabled={cannotDecide || !count} onClick={() => onReject(null)}>Reject all</Button>
        <Button size="sm" variant="ghost" disabled={cannotDecide || count > 0} onClick={onStop}>Return to editing</Button>
      </div>
    </div>
    {stale && !snapshot.busy && <p role="alert">The accepted file changed or moved. These suggestions need a new review before acceptance. Export the proposed source to keep a separate copy.</p>}
    {snapshot.error && <p role="alert">{snapshot.error} <Button size="sm" variant="link" onClick={onKeep} disabled={cannotDecide}>{shared ? "Try saving suggestions again" : "Try keeping review again"}</Button>{shared && onReload && <Button size="sm" variant="link" onClick={onReload} disabled={busy}>Reload shared review</Button>}</p>}
    <p role="status" className="local-suggestions-status">{snapshot.busy ? "Finishing decision…" : snapshot.keeping ? (shared ? "Saving suggestions…" : "Keeping review…") : snapshot.kept ? (shared ? "Suggestions saved to the project." : "Review kept in this browser.") : (shared ? "Suggestions have not been saved. Keep this tab open and retry or export." : "Review has not been kept. Export the proposed source before leaving.")}</p>
    <OriginalReviewDetails review={review} />
    {count === 0 ? <p>{shared ? "Returning to editing keeps the completed review and its original details in this project." : review.provenance
      ? "Returning to editing removes this local review, including imported comments and revision details. Use File actions, then Export suggestions to keep a copy."
      : "Type in Source or Rendered to propose a change."}</p> : <ul className="local-suggestions-list">
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
          <Button size="sm" variant="outline" disabled={cannotDecide || stale} onClick={() => onAccept(suggestion.id)}>Accept suggestion</Button>
          <Button size="sm" variant="ghost" disabled={cannotDecide} onClick={() => onReject(suggestion.id)}>Reject suggestion</Button>
        </div>
      </li>)}
    </ul>}
  </section>;
}
