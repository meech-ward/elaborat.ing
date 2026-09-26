import { createFileRoute } from "@tanstack/react-router"
import { ProjectPage, ProjectRoute } from "@/features/projects"

export const Route = createFileRoute("/projects/$projectId/")({
  component: () => <ProjectRoute>{(account) => <ProjectPage account={account} />}</ProjectRoute>,
})
