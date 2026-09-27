import { createFileRoute } from "@tanstack/react-router"
import { useEffect } from "react"
import { StyleGuidePage } from "@/features/design-system"

// The component library's style guide. Not linked from the app, and kept out
// of search results.
export const Route = createFileRoute("/style-guide")({
  component: StyleGuide,
})

function StyleGuide() {
  useEffect(() => {
    const robots = document.createElement("meta")
    robots.name = "robots"
    robots.content = "noindex"
    document.head.append(robots)
    const title = document.title
    document.title = "Style guide · elaborat.ing"
    return () => {
      robots.remove()
      document.title = title
    }
  }, [])
  return <StyleGuidePage />
}
