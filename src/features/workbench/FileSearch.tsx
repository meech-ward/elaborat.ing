import { useEffect, useState, type ReactNode } from "react";
import { SidebarMenu } from "@/components/ui/sidebar";
import { SearchField, SearchHitRow, type PanelRowSize } from "@/features/design-system";
import { cn } from "@/lib/utils";
import { snippet, type FileSearchHit } from "./contentSearch";
import { kindForPath } from "./session";

/** Wait this long after typing stops before searching. */
const DEBOUNCE_MS = 250;

type Result = { query: string; hits: FileSearchHit[] } | { query: string; error: string };

/**
 * A field at the top of the files panel that finds files in this project by
 * their text, on the server. While it has text, the matching files, each
 * with a snippet, take the place of the tree; choosing one opens it, and
 * Escape clears the field.
 */
export function FileSearch({ search, unavailable = "Search needs a connection.", size = "default", onOpen, actions, children }: {
  /** Finds files in this project by their text; null when there is no connection or no account. */
  search: ((query: string) => Promise<FileSearchHit[]>) | null;
  /** What the results say when there is no `search`. */
  unavailable?: ReactNode;
  /** `touch` on the phone's files screen. */
  size?: PanelRowSize;
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
      <div role="search" className={size === "touch" ? "mb-2" : "mx-0.5 mb-1.5"}>
        <SearchField
          size={size}
          aria-label="Search notes, drawings and diagrams"
          placeholder="Search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onClear={() => setQuery("")}
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
        <section aria-label="Search results" className="min-h-0 flex-1 overflow-y-auto">
          {status && (
            <p role="status" className={cn("px-2 py-1.5 text-muted-foreground", size === "touch" ? "text-[15px]" : "text-[13px]")}>
              {status}
            </p>
          )}
          {hits.length > 0 && (
            <SidebarMenu>
              {hits.map((hit) => {
                const { before, match, after } = snippet(hit.text, trimmed);
                return (
                  <SearchHitRow
                    key={hit.path}
                    path={hit.path}
                    kind={kindForPath(hit.path)}
                    before={before}
                    match={match}
                    after={after}
                    size={size}
                    onClick={() => onOpen(hit.path)}
                  />
                );
              })}
            </SidebarMenu>
          )}
        </section>
      ) : (
        children
      )}
    </>
  );
}
