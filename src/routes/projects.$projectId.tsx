import { createFileRoute } from "@tanstack/react-router"
import { ProjectPage, ProjectRoute } from "@/features/projects"
import { preloadWorkbench } from "@/features/workbench/load"

// A project, at `/projects/<id>` or at one of its files: `/projects/<id>/<file path>`.
// The page renders here, once for both child routes, so moving between them
// (closing the last tab, opening a file) keeps it and its workbench mounted.
export const Route = createFileRoute("/projects/$projectId")({
  // Start loading the editor now, alongside the session check.
  loader: () => preloadWorkbench(),
  component: () => <ProjectRoute>{(account) => <ProjectPage account={account} />}</ProjectRoute>,
})
