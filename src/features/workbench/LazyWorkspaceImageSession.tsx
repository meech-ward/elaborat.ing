import type { ComponentProps } from "react";
import { Banner, BannerAction, LoadingLine } from "@/features/design-system";
import { moduleLoader, useModule } from "@/lib/moduleLoader";
import { FileHeader } from "./FileHeader";
import type { WorkspaceImageSession } from "./WorkspaceImageSession";

const imageSession = moduleLoader(() => import("./WorkspaceImageSession"));

/** Standalone image controls and comparisons load when an image file opens. */
export function LazyWorkspaceImageSession(props: ComponentProps<typeof WorkspaceImageSession>) {
  const { module, error, retry } = useModule(imageSession, true);
  if (module) return <module.WorkspaceImageSession {...props} />;
  return <div className="flex h-full min-h-0 flex-col">
    <FileHeader path={props.path} active={props.active} navigation={props.navigation} save={null} actions={[]} />
    {error ? <Banner tone="danger" className="m-2" action={<BannerAction onClick={retry}>Try again</BannerAction>}>The image could not load.</Banner> : <LoadingLine label="Loading image" />}
  </div>;
}
