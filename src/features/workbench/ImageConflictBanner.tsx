import { useEffect, useState } from "react";
import { Banner } from "@/features/design-system";
import type { ImageAsset } from "@/features/images/types";
import type { ConflictChoice } from "@/features/project-storage/sync";
import { ConflictBanner } from "./ConflictBanner";
import type { WorkspaceStore } from "./workspaceStore";

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Image files keep their resolution feedback and cached previews in their own chunk. */
export function ImageConflictBanner({ path, client, draft, onResolveConflict }: {
  path: string;
  client: Pick<WorkspaceStore, "readConflict" | "readImageAsset">;
  draft: boolean;
  onResolveConflict?: (choice: ConflictChoice) => Promise<void>;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  return <div className="px-4">
    {onResolveConflict ? <ConflictBanner name={path.split("/").at(-1) ?? path} path={path} client={client}
      compareAs={{ kind: "custom", description: "The image on the server and on this device. Choose which version to keep.", render: copies => <div className="wb-compare-pictures">
        <ImageComparison asset={copies.theirsAsset} readImageAsset={client.readImageAsset} caption="On the server" />
        <ImageComparison asset={copies.mineAsset} readImageAsset={client.readImageAsset} caption="On this device" />
      </div> }}
      noun="image" hasUnsavedEdits={() => draft} onResolveConflict={onResolveConflict} onNotice={setNotice} /> : <Banner role="alert" tone="warn">This image was changed on another device too. Its sync is waiting for someone with edit access to choose a version.</Banner>}
    {notice ? <p role="status" className="mt-2 text-sm text-muted-foreground">{notice}</p> : null}
  </div>;
}

/** Comparison uses only this project's cached bytes, with animation held still. */
function ImageComparison({ asset, readImageAsset, caption }: { asset?: ImageAsset | null; readImageAsset: WorkspaceStore["readImageAsset"]; caption: string }) {
  const [picture, setPicture] = useState<{ id: string; url?: string; error?: string } | null>(null);
  useEffect(() => {
    if (!asset) return;
    let live = true;
    let url: string | undefined;
    void (async () => {
      if (!readImageAsset) throw new Error("The image preview is unavailable on this device.");
      let bytes = await readImageAsset(asset.id, true);
      const { inspectImage } = await import("@/features/images/format");
      if (inspectImage(new Uint8Array(await bytes.arrayBuffer()), bytes.type).animated) {
        const { prepareImage } = await import("@/features/images/prepare");
        bytes = (await prepareImage(bytes, asset.object_key.split("/")[0])).preview;
      }
      if (!live) return;
      url = URL.createObjectURL(bytes);
      setPicture({ id: asset.id, url });
    })().catch((error: unknown) => { if (live) setPicture({ id: asset.id, error: message(error) }); });
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, [asset, readImageAsset]);
  const shown = picture?.id === asset?.id ? picture : null;
  return <figure>
    <figcaption>{caption}</figcaption>
    {!asset ? <p>This image was deleted.</p> : <>
      {shown?.url ? <img src={shown.url} alt={`The image ${caption.toLowerCase()}`} /> : <p role="status">{shown?.error ?? "Loading image preview…"}</p>}
      <p>{asset.width} × {asset.height} · {(asset.byte_length / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} kB · {asset.media_type.replace("image/", "").toUpperCase()}</p>
      <p className="break-all text-xs text-muted-foreground">Version {asset.id}</p>
    </>}
  </figure>;
}
