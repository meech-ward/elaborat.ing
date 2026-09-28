import type { RenderedEditorProps } from "@/features/rendered";
import { Banner, BannerAction, LoadingLine } from "@/features/design-system";
import { moduleLoader, useModule } from "@/lib/moduleLoader";

// The rendered note (its frame, with the frame's React, MDX runtime and
// components as one string, and the editing between them) loads in its own
// chunk the first time a note shows Rendered or Split.
const renderedEditor = moduleLoader(() => import("@/features/rendered/RenderedEditor"));

/** Start loading the rendered note, for example when the pointer reaches the view switch. */
export function preloadRenderedEditor(): void {
  renderedEditor.preload();
}

/** The rendered note once its chunk has loaded: a loading line until then, and Try again when it fails. */
export function LazyRenderedEditor(props: RenderedEditorProps) {
  const { module, error, retry } = useModule(renderedEditor, true);
  if (module) {
    const { RenderedEditor } = module;
    return <RenderedEditor {...props} />;
  }
  if (error)
    return (
      <Banner tone="danger" className="mt-2" action={<BannerAction onClick={retry}>Try again</BannerAction>}>
        The rendered note could not load.
      </Banner>
    );
  return <LoadingLine label="Loading the rendered note" />;
}
