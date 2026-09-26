import { createFileRoute } from "@tanstack/react-router"
import { ProjectPage, ProjectRoute } from "@/features/projects"

// A file in a project: `/projects/<id>/<file path>`, parsed from the encoded URL.
export const Route = createFileRoute("/projects/$projectId/$")({
  component: () => <ProjectRoute>{(account) => <ProjectPage account={account} />}</ProjectRoute>,
})
