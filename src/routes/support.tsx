import { createFileRoute } from "@tanstack/react-router"
import { SupportPage } from "@/features/legal"

export const Route = createFileRoute("/support")({
  component: SupportPage,
})
