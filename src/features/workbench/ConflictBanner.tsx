import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { Banner, BannerAction, LoadingLine } from "@/features/design-system";
import { countElementChanges } from "@/features/drawings/serialize.ts";
import { parseDrawingFile } from "@/features/drawings/parse.ts";
import type { ConflictCopies } from "@/features/project-storage/fileStore";
import type { ConflictChoice } from "@/features/project-storage/sync";
import { moduleLoader, useModule } from "@/lib/moduleLoader";
import { drawingSvgForContent } from "./resources";
import type { WorkspaceStore } from "./workspaceStore";
import { dialogError } from "./dialogMessages";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** How to compare a conflicted file: its text in a diff (with a Monaco language id), or a drawing as two pictures. */
export type CompareAs = { kind: "text"; language: string } | { kind: "drawing" };

/**
 * Sync stopped because a file changed on this device and elsewhere. The
 * banner offers the three choices, and Compare, which shows what differs
 * first, with the same choices beside it.
 */
export function ConflictBanner({ name, path, client, compareAs, noun, hasUnsavedEdits, onResolveConflict, onNotice }: {
  /** The file as the message names it. */
  name: string;
  path: string;
  client: Pick<WorkspaceStore, "readConflict">;
  compareAs: CompareAs;
  /** What the unsaved-edits confirmation calls the file: "file", "drawing" or "diagram". */
  noun: string;
  /** The editor holds unsaved edits, which Keep theirs and Keep both replace. */
  hasUnsavedEdits: () => boolean;
  onResolveConflict: (choice: ConflictChoice) => Promise<void>;
  /** Say what happened in the editor's status line, or clear it. */
  onNotice: (text: string | null) => void;
}) {
  const [resolving, setResolving] = useState(false);
  // Both copies while Compare is open.
  const [copies, setCopies] = useState<ConflictCopies | null>(null);
  const [compareError, setCompareError] = useState<string | null>(null);

  /** True once resolved, false if the person chose to keep their unsaved edits after all. Throws when the choice fails. */
  const settle = async (choice: ConflictChoice): Promise<boolean> => {
    if (hasUnsavedEdits() && choice !== "mine" && !window.confirm(`Your unsaved edits to this ${noun} will be replaced. Continue?`)) return false;
    setResolving(true);
    onNotice(null);
    try {
      await onResolveConflict(choice);
    } finally {
      setResolving(false);
    }
    onNotice(choice === "mine" ? "Keeping your version." : choice === "theirs" ? "Took the other version." : "Kept both: your version is saved as a copy.");
    return true;
  };

  const resolve = async (choice: ConflictChoice) => {
    try {
      await settle(choice);
    } catch (error) {
      onNotice(`Could not resolve: ${message(error)}`);
    }
  };

  const compare = async () => {
    try {
      const found = await client.readConflict(path);
      setCompareError(null);
      setCopies(found);
    } catch (error) {
      onNotice(`Could not compare: ${message(error)}`);
    }
  };

  const choose = async (choice: ConflictChoice) => {
    setCompareError(null);
    try {
      if (await settle(choice)) setCopies(null);
    } catch (error) {
      setCompareError(`Could not resolve: ${message(error)}`);
    }
  };

  return (
    <Banner
      role="alert"
      className="mt-2"
      action={
        <span className="inline-flex flex-wrap gap-x-3">
          <BannerAction disabled={resolving} onClick={() => void compare()}>Compare</BannerAction>
          <BannerAction disabled={resolving} onClick={() => void resolve("mine")}>Keep mine</BannerAction>
          <BannerAction disabled={resolving} onClick={() => void resolve("theirs")}>Keep theirs</BannerAction>
          <BannerAction disabled={resolving} onClick={() => void resolve("both")}>Keep both</BannerAction>
        </span>
      }
    >
      {name} was changed on another device too, so its sync stopped. Choose which version to keep.
      {copies ? (
        <CompareDialog
          name={name}
          path={path}
          copies={copies}
          compareAs={compareAs}
          unsaved={hasUnsavedEdits()}
          resolving={resolving}
          error={compareError}
          onChoose={(choice) => void choose(choice)}
          onClose={() => setCopies(null)}
        />
      ) : null}
    </Banner>
  );
}

/** The server's copy and this device's side by side, with the choices. */
function CompareDialog({ name, path, copies, compareAs, unsaved, resolving, error, onChoose, onClose }: {
  name: string;
  path: string;
  copies: ConflictCopies;
  compareAs: CompareAs;
  unsaved: boolean;
  resolving: boolean;
  error: string | null;
  onChoose: (choice: ConflictChoice) => void;
  onClose: () => void;
}) {
  const close = useRef<HTMLButtonElement>(null);
  const { mine, theirs } = copies;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !resolving) onClose();
      }}
    >
      <DialogContent className="wb-compare" aria-busy={resolving} initialFocus={close} showCloseButton={false}>
        <DialogTitle>Compare {name}</DialogTitle>
        <DialogDescription>
          {theirs === null
            ? `The server no longer has ${name}: it was deleted there. Your copy is still on this device.`
            : mine === null
              ? `${name} was deleted on this device, and changed on the server.`
              : compareAs.kind === "text"
                ? "What changed on the server and on this device. Choose which version to keep."
                : "The drawing on the server and on this device. Choose which version to keep."}
        </DialogDescription>
        {theirs !== null && mine !== null ? (
          compareAs.kind === "text" ? (
            <TextComparison theirs={theirs} mine={mine} language={compareAs.language} />
          ) : (
            <DrawingComparison theirs={theirs} mine={mine} path={path} />
          )
        ) : null}
        {unsaved ? <p className="wb-compare-note">Your unsaved edits are not shown here. Keep mine keeps them; the other choices replace them.</p> : null}
        {error ? (
          <p role="alert" className={dialogError}>
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button ref={close} variant="outline" disabled={resolving} onClick={onClose}>
            Close
          </Button>
          <Button variant="secondary" disabled={resolving} onClick={() => onChoose("mine")}>
            Keep mine
          </Button>
          <Button variant="secondary" disabled={resolving} onClick={() => onChoose("theirs")}>
            Keep theirs
          </Button>
          <Button variant="secondary" disabled={resolving} onClick={() => onChoose("both")}>
            Keep both
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type Picture = { svg: string } | { error: string };

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Both versions of a drawing as pictures (the SVG export embeds use), and how many elements differ. */
function DrawingComparison({ theirs, mine, path }: { theirs: string; mine: string; path: string }) {
  const [shown, setShown] = useState<{ theirs: Picture; mine: Picture; changes: ReturnType<typeof countElementChanges> | null } | null>(null);

  useEffect(() => {
    let current = true;
    const picture = async (content: string): Promise<Picture> => {
      try {
        return { svg: await drawingSvgForContent(content, path) };
      } catch (error) {
        return { error: message(error) };
      }
    };
    let changes: ReturnType<typeof countElementChanges> | null = null;
    try {
      changes = countElementChanges(parseDrawingFile(theirs, path).scene, parseDrawingFile(mine, path).scene);
    } catch {
      // A copy that is not a valid drawing has nothing to count; its picture says why.
    }
    void Promise.all([picture(theirs), picture(mine)]).then(([server, device]) => {
      if (current) setShown({ theirs: server, mine: device, changes });
    });
    return () => {
      current = false;
    };
  }, [theirs, mine, path]);

  if (!shown) return <p role="status">Drawing both versions…</p>;
  const figure = (picture: Picture, caption: string, alt: string) => (
    <figure>
      <figcaption>{caption}</figcaption>
      {"svg" in picture ? (
        <img alt={alt} src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(picture.svg)}`} />
      ) : (
        <p className={dialogError}>This version could not be drawn: {picture.error}</p>
      )}
    </figure>
  );
  const { changes } = shown;
  return (
    <>
      {changes ? (
        <p>
          Compared with the server's copy, yours has {count(changes.added, "element")} added, {changes.removed} removed and {changes.changed} changed.
        </p>
      ) : null}
      <div className="wb-compare-pictures">
        {figure(shown.theirs, "On the server", "The drawing on the server")}
        {figure(shown.mine, "On this device", "The drawing on this device")}
      </div>
    </>
  );
}

// Monaco's diff editor loads the first time a text comparison shows.
const conflictDiff = moduleLoader(() => import("./ConflictDiff"));

function TextComparison(props: { theirs: string; mine: string; language: string }) {
  const { module, error, retry } = useModule(conflictDiff, true);
  if (module) {
    const { ConflictDiff } = module;
    return <ConflictDiff {...props} />;
  }
  if (error)
    return (
      <Banner tone="danger" action={<BannerAction onClick={retry}>Try again</BannerAction>}>
        The comparison could not load.
      </Banner>
    );
  return <LoadingLine label="Loading the comparison" />;
}
