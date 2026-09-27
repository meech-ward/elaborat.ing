import { createFileRoute } from "@tanstack/react-router"
import { Brand, DottedPage } from "@/components/panel"
import { AccountHeader } from "@/features/auth"
import { ProjectsHome } from "@/features/projects"

export const Route = createFileRoute("/")({
  component: Home,
})

function Home() {
  return (
    <DottedPage>
      <div className="mx-auto flex max-w-[640px] flex-col gap-4 px-4 py-10 sm:py-16">
        <AccountHeader>
          <div className="flex flex-col gap-2 px-1">
            <h1 className="text-[32px] leading-tight">
              <Brand />
            </h1>
            <p className="text-muted-foreground">Documents and diagrams for people who like Markdown, and the agents they work with.</p>
          </div>
        </AccountHeader>
        <main>
          <ProjectsHome />
        </main>
      </div>
    </DottedPage>
  )
}
