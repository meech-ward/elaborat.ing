import type { ComponentProps, ReactNode } from "react";
import { Banner, BannerAction, LoadingLine } from "@/features/design-system";
import { moduleLoader, useModule, type ModuleLoader } from "@/lib/moduleLoader";
import type { DrawingView as DrawingViewComponent } from "./DrawingView";
import type { DiagramView as DiagramViewComponent } from "./DiagramView";
import { FileHeader } from "./FileHeader";

// A drawing's and a diagram's views (Excalidraw's styles, the canvas and its
// controls, the diagram's regeneration) each load in their own chunk the
// first time a file of that kind opens. Excalidraw itself loads when the
// canvas first shows (DrawingCanvas), and D2 when a diagram first compiles.
const drawingView = moduleLoader(() => import("./DrawingView"));
const diagramView = moduleLoader(() => import("./DiagramView"));

type HeaderProps = Pick<ComponentProps<typeof DrawingViewComponent>, "initial" | "active" | "navigation">;

/**
 * The view's module, or what shows until it has loaded: the file's header
 * (on a phone, Back), then a loading line, or Try again when it failed.
 */
function useLoadedView<T extends object>(loader: ModuleLoader<T>, noun: string, { initial, active, navigation }: HeaderProps): { module: T | null; fallback: ReactNode } {
  const { module, error, retry } = useModule(loader, true);
  if (module) return { module, fallback: null };
  const header = <FileHeader path={initial.path} active={active} navigation={navigation} save={null} actions={[]} />;
  if (error)
    return {
      module: null,
      fallback: (
        <>
          {header}
          <Banner tone="danger" className="m-2" action={<BannerAction onClick={retry}>Try again</BannerAction>}>
            The {noun} could not load.
          </Banner>
        </>
      ),
    };
  return {
    module: null,
    fallback: (
      <>
        {header}
        <LoadingLine label={`Loading the ${noun}`} />
      </>
    ),
  };
}

/** An open drawing once its view's chunk has loaded: a loading line until then, and Try again when it fails. */
export function LazyDrawingView(props: ComponentProps<typeof DrawingViewComponent>) {
  const { module, fallback } = useLoadedView(drawingView, "drawing", props);
  if (!module) return fallback;
  const { DrawingView } = module;
  return <DrawingView {...props} />;
}

/** An open diagram once its view's chunk has loaded: a loading line until then, and Try again when it fails. */
export function LazyDiagramView(props: ComponentProps<typeof DiagramViewComponent>) {
  const { module, fallback } = useLoadedView(diagramView, "diagram", props);
  if (!module) return fallback;
  const { DiagramView } = module;
  return <DiagramView {...props} />;
}
