import { createFileRoute } from "@tanstack/react-router"

// A file in a project: `/projects/<id>/<file path>`. Its parent route renders
// the page, which parses the file path from the encoded URL.
export const Route = createFileRoute("/projects/$projectId/$")()
