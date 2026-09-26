import { createFileRoute } from "@tanstack/react-router"
import { ProjectPage, ProjectRoute } from "@/features/projects"
import { preloadWorkbench } from "@/features/workbench/load"

// A file in a project: `/projects/<id>/<file path>`, parsed from the encoded URL.
export const Route = createFileRoute("/projects/$projectId/$")({
  // Start loading the editor now, alongside the session check.
  loader: () => preloadWorkbench(),
  component: () => <ProjectRoute>{(account) => <ProjectPage account={account} />}</ProjectRoute>,
})
