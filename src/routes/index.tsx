import { createFileRoute } from "@tanstack/react-router"
import { DottedPage } from "@/components/panel"
import { AccountHeader } from "@/features/auth"
import { ProjectsHome } from "@/features/projects"

export const Route = createFileRoute("/")({
  component: Home,
})

function Home() {
  return (
    <DottedPage className="flex flex-col">
      <AccountHeader />
      <main className="flex flex-1 flex-col">
        <ProjectsHome />
      </main>
    </DottedPage>
  )
}
