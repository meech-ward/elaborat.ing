import { Search } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { snippet, type FileSearchHit } from "./contentSearch";

/** Wait this long after typing stops before searching. */
const DEBOUNCE_MS = 250;

type Result = { query: string; hits: FileSearchHit[] } | { query: string; error: string };

/**
 * A field at the top of the files panel that finds files in this project by
 * their text, on the server. While it has text, the matching files, each
 * with a snippet, take the place of the tree; choosing one opens it, and
 * Escape clears the field.
 */
export function FileSearch({ search, unavailable = "Search needs a connection.", onOpen, actions, children }: {
  /** Finds files in this project by their text; null when there is no connection or no account. */
  search: ((query: string) => Promise<FileSearchHit[]>) | null;
  /** What the results say when there is no `search`. */
  unavailable?: ReactNode;
  onOpen: (path: string) => void;
  /** Shown under the field whether or not it has text. */
  actions?: ReactNode;
  /** The tree, which the results replace while the field has text. */
  children: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const trimmed = query.trim();

  useEffect(() => {
    if (!trimmed || !search) return;
    let current = true;
    const timer = setTimeout(() => {
      search(trimmed).then(
        (hits) => current && setResult({ query: trimmed, hits }),
        (cause: unknown) => current && setResult({ query: trimmed, error: cause instanceof Error ? cause.message : String(cause) }),
      );
    }, DEBOUNCE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [search, trimmed]);

  const answered = result?.query === trimmed ? result : null;
  const hits = answered && "hits" in answered ? answered.hits : [];
  const status = !search
    ? unavailable
    : !answered
      ? "Searching…"
      : "error" in answered
        ? answered.error
        : hits.length === 0
          ? "No files match."
          : null;

  return (
    <>
      <div className="wb-file-search" role="search">
        <Search size={14} aria-hidden="true" />
        <input
          type="search"
          aria-label="Search notes, drawings and diagrams"
          placeholder="Search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && query) {
              event.preventDefault();
              event.stopPropagation();
              setQuery("");
            } else if (event.key === "Enter" && hits[0]) {
              event.preventDefault();
              onOpen(hits[0].path);
            }
          }}
        />
      </div>
      {actions}
      {trimmed ? (
        <section className="wb-search-results" aria-label="Search results">
          {status && <p role="status">{status}</p>}
          {hits.length > 0 && (
            <ul>
              {hits.map((hit) => {
                const { before, match, after } = snippet(hit.text, trimmed);
                return (
                  <li key={hit.path}>
                    <button type="button" onClick={() => onOpen(hit.path)}>
                      <span className="wb-search-path">{hit.path}</span>
                      <span className="wb-search-snippet">
                        {before}
                        {match && <strong>{match}</strong>}
                        {after}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ) : (
        children
      )}
    </>
  );
}
