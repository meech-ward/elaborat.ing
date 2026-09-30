// Temporary host capability probe, remove after testing.
import { createFileRoute } from "@tanstack/react-router"
import { EmbedProbePage } from "@/features/host-probe/EmbedProbePage"

export const Route = createFileRoute("/embed-probe")({
  component: EmbedProbePage,
})
