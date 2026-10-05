import { describe, expect, test } from "bun:test"
import { createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router"
import { projectHref } from "@/features/navigation/location"
import { EMBED_BASE, isEmbedPath, requestedScheme, sitePath } from "./mode"

// The app in a chat's panel runs under /embed as the router's basepath: the
// href the app reads (useLocation's) and the hrefs it navigates to stay
// unprefixed, while the address bar and links carry /embed.

const ID = "0b6a4a52-6f3e-4c1a-9d59-3b7f1c2a9e01"

function panelRouter(at: string) {
  const root = createRootRoute()
  const home = createRoute({ getParentRoute: () => root, path: "/" })
  const project = createRoute({ getParentRoute: () => root, path: "/projects/$projectId" })
  const file = createRoute({ getParentRoute: () => project, path: "$" })
  const history = createMemoryHistory({ initialEntries: [at] })
  const router = createRouter({ routeTree: root.addChildren([home, project.addChildren([file])]), history, basepath: EMBED_BASE })
  return { router, history }
}

describe("the router under /embed", () => {
  test("reads a project file's href without the prefix", async () => {
    const { router } = panelRouter(`/embed/projects/${ID}/notes/a%20b.mdx?theme=dark`)
    await router.load()
    expect(router.state.location.href).toBe(`/projects/${ID}/notes/a%20b.mdx?theme=dark`)
    expect(router.state.location.pathname.startsWith("/projects/")).toBe(true)
  })

  test("navigates to an unprefixed href, and the address carries /embed", async () => {
    const { router, history } = panelRouter("/embed")
    await router.load()
    expect(router.state.location.href).toBe("/")
    await router.navigate({ href: projectHref(ID, "notes/a b.mdx") })
    expect(router.state.location.href).toBe(projectHref(ID, "notes/a b.mdx"))
    expect(history.location.pathname).toBe(`/embed/projects/${ID}/notes/a%20b.mdx`)
    await router.navigate({ to: "/" })
    expect(router.state.location.href).toBe("/")
    expect(history.location.pathname.replace(/\/$/, "")).toBe("/embed")
    expect(router.buildLocation({ to: projectHref(ID) }).publicHref).toBe(`/embed/projects/${ID}`)
  })
})

describe("embed paths", () => {
  test("are /embed and below it, never /embed-probe", () => {
    expect(["/embed", "/embed/", "/embed/projects/x"].every(isEmbedPath)).toBe(true)
    expect(["/", "/embed-probe", "/embedded", "/projects/x"].some(isEmbedPath)).toBe(false)
  })

  test("map to the same page on the site", () => {
    expect(sitePath("/embed")).toBe("/")
    expect(sitePath("/embed/")).toBe("/")
    expect(sitePath(`/embed/projects/${ID}/a%20b.mdx`)).toBe(`/projects/${ID}/a%20b.mdx`)
    expect(sitePath("/sign-in")).toBe("/sign-in")
  })

  test("stay on this site when the path after /embed starts with more slashes", () => {
    expect(sitePath("/embed//evil.com")).toBe("/evil.com")
    expect(sitePath("/embed///evil.com")).toBe("/evil.com")
    expect(sitePath("/embed//evil.com/x")).toBe("/evil.com/x")
    expect(new URL(sitePath("/embed//evil.com"), "https://site.test").origin).toBe("https://site.test")
  })

  test("take light or dark from ?theme=, and nothing else", () => {
    expect(requestedScheme("?theme=dark")).toBe("dark")
    expect(requestedScheme("?x=1&theme=light")).toBe("light")
    expect(requestedScheme("?theme=blue")).toBeNull()
    expect(requestedScheme("")).toBeNull()
  })
})
