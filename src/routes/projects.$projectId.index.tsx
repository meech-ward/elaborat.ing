import { createFileRoute } from "@tanstack/react-router"

// A project with no file in the URL. Its parent route renders the page.
export const Route = createFileRoute("/projects/$projectId/")()
