import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/")({
  component: Home,
})

function Home() {
  return (
    <main className="mx-auto flex min-h-svh max-w-2xl flex-col justify-center gap-4 px-6">
      <h1 className="text-4xl font-semibold tracking-tight">elaborat.ing</h1>
      <p className="text-lg text-neutral-600">
        Documents and diagrams for people who like Markdown, and the agents they work with.
        Open source, and being built in public.
      </p>
    </main>
  )
}
