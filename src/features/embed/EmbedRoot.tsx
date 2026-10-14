import { Link, Outlet, useLocation, useRouterState } from "@tanstack/react-router"
import { ChevronLeft, ExternalLink } from "lucide-react"
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react"
import { LoginForm } from "@/components/login-form"
import { DottedPage, panel } from "@/components/panel"
import { buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { useAppearance } from "@/features/appearance"
import { signOut } from "@/features/auth/useAuth"
import { AccountPill, AppBar, Banner, ConfirmActionHost } from "@/features/design-system"
import { parseProjectLocation } from "@/features/navigation"
import { ProjectsHome, useProjectAccount, type ProjectAccount } from "@/features/projects"
import { libraryFor } from "@/features/projects/account"
import { kindForPath } from "@/features/workbench/session"
import { loadClient } from "@/lib/supabase/client"
import { cn } from "@/lib/utils"
import { framed, panelPass } from "./mode"

// The app in a chat's panel (docs/architecture.md, Frontend hosting): the
// page around the routes when it runs under /embed. Only the projects and a
// project's workbench show here; any other page opens on the site. The
// panel keeps a sign-in of its own, and shows a project only after it has
// redeemed the pass the view put in its address (#pass=, read in mode.ts),
// as the signed-in person. It talks to the view that frames it:
//   to the view    {type: "elaborating-embed:ready"} once it has started,
//                  {type: "elaborating-embed:open", url} for a link to the site,
//                  {type: "elaborating-embed:pass"} when it has no pass that works,
//                  {type: "elaborating-embed:location", project, file} when what
//                  is open changes: project {id, name} and file {path, kind:
//                  "note" | "drawing" | "diagram" | "other"}, each or null
//   from the view  {type: "elaborating-embed:theme", theme: "light" | "dark"}

const READY = "elaborating-embed:ready"
const OPEN = "elaborating-embed:open"
const PASS = "elaborating-embed:pass"
const LOCATION = "elaborating-embed:location"
const THEME = "elaborating-embed:theme"

/** The view's origin, where messages to it go, as the browser gives it (the referrer where ancestorOrigins is missing). */
function viewOrigin(): string | null {
  let origin: string | null = null
  if (window.location.ancestorOrigins?.length) origin = window.location.ancestorOrigins[0]
  else {
    try {
      origin = document.referrer ? new URL(document.referrer).origin : null
    } catch {
      origin = null
    }
  }
  return origin && origin !== "null" ? origin : null
}

/** Sends a message to the view that frames the app; false when there is none to send it to. */
function tellView(message: Record<string, unknown>): boolean {
  const origin = framed() ? viewOrigin() : null
  if (!origin) return false
  window.parent.postMessage(message, origin)
  return true
}

/** Says it is ready, follows the view's light or dark, and opens links to the site through the view. */
function useView() {
  const { setMode } = useAppearance()
  useEffect(() => {
    tellView({ type: READY })
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent) return
      const data: unknown = event.data
      if (typeof data !== "object" || data === null || (data as { type?: unknown }).type !== THEME) return
      const theme = (data as { theme?: unknown }).theme
      if (theme === "light" || theme === "dark") setMode(theme)
    }
    // A link to a page of the site (a new tab) goes to the view, which asks the chat to open it.
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return
      const link = event.target instanceof Element ? event.target.closest("a[target=_blank]") : null
      if (!(link instanceof HTMLAnchorElement) || new URL(link.href).origin !== window.location.origin) return
      if (tellView({ type: OPEN, url: link.href })) event.preventDefault()
    }
    window.addEventListener("message", onMessage)
    document.addEventListener("click", onClick)
    return () => {
      window.removeEventListener("message", onMessage)
      document.removeEventListener("click", onClick)
    }
  }, [setMode])
  // No service worker in the panel: one an earlier visit left in this frame's storage is removed.
  useEffect(() => {
    void navigator.serviceWorker
      ?.getRegistrations()
      .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
      .catch(() => {})
  }, [])
}

/** The kind of file the view names, by the app's kind for its path. */
const KINDS = { note: "note", drawing: "drawing", diagram: "diagram", text: "other" } as const

/** The project's name in the account's library, once the library has the project; null without one. */
function useProjectName(account: ProjectAccount | null, projectId: string | null): string | null {
  const library = account && projectId ? libraryFor(account) : null
  const state = useSyncExternalStore(
    (notify) => (library ? library.subscribe(notify) : () => {}),
    () => (library ? library.getState() : null),
  )
  return state?.entries.find((entry) => entry.id === projectId)?.title ?? null
}

/**
 * Tells the view what the person has open whenever it changes: the project
 * on screen and the file open in it (the one in the address), or nothing
 * (`href` null). The view tells the chat's model. A project shows as open
 * once the library has its name.
 */
function useTellLocation(account: ProjectAccount | null, href: string | null) {
  const location = href === null ? null : parseProjectLocation(href)
  const projectId = location?.kind === "project" ? location.projectId : null
  const name = useProjectName(account, projectId)
  const id = name === null ? null : projectId
  const path = id !== null && location?.kind === "project" ? location.path : null
  useEffect(() => {
    const project = id !== null && name !== null ? { id, name } : null
    tellView({ type: LOCATION, project, file: project && path !== null ? { path, kind: KINDS[kindForPath(path)] } : null })
  }, [id, name, path])
}

/** The pass this page was opened with, until an account redeems it. */
let unusedPass = panelPass
const redemptions = new Map<string, Promise<boolean>>()
let askedForPass = false

/**
 * Whether this page may show `userId`'s projects: true once that account has
 * redeemed the page's pass. Asked once per account; on false the view is
 * asked, once, for a new pass (it opens the page again with one).
 */
function redeemPass(userId: string): Promise<boolean> {
  let redemption = redemptions.get(userId)
  if (!redemption) {
    const pass = unusedPass
    const redeem = async () => {
      if (!pass) return false
      const { data, error } = await (await loadClient()).rpc("redeem_panel_pass", { pass })
      return !error && data === true
    }
    redemption = redeem()
      .catch(() => false)
      .then((open) => {
        if (open) unusedPass = null
        else if (!askedForPass) askedForPass = tellView({ type: PASS })
        return open
      })
    redemptions.set(userId, redemption)
  }
  return redemption
}

/** Whether the signed-in account may see its projects here: "checking", then "open" or "closed". */
function usePass(userId: string | null): "checking" | "open" | "closed" {
  const [result, setResult] = useState<{ userId: string; open: boolean } | null>(null)
  useEffect(() => {
    if (!userId) return
    let current = true
    void redeemPass(userId).then((open) => {
      if (current) setResult({ userId, open })
    })
    return () => {
      current = false
    }
  }, [userId])
  if (!userId || result?.userId !== userId) return "checking"
  return result.open ? "open" : "closed"
}

/** "Open in elaborat.ing": the same page on the site, in a new tab. */
function OpenOnSite({ url, className, label = "Open in elaborat.ing" }: { url: string; className?: string; label?: string }) {
  return (
    <a href={url} target="_blank" rel="noopener" className={className}>
      <ExternalLink data-icon="inline-start" aria-hidden="true" />
      {label}
    </a>
  )
}

function EmbedBar({ url, onProject, email }: { url: string; onProject: boolean; email?: string | null }) {
  const [error, setError] = useState<string | null>(null)
  return (
    <AppBar
      size="compact"
      // Above a drawing's canvas, which bleeds under the whole page as it
      // does under the workbench's own panels: otherwise it hides the bar.
      className="relative z-10"
      home={<Link to="/" />}
      actions={
        <>
          {onProject && (
            <Link to="/" className={buttonVariants({ variant: "ghost", size: "sm" })}>
              <ChevronLeft data-icon="inline-start" aria-hidden="true" />
              Projects
            </Link>
          )}
          <a href={url} target="_blank" rel="noopener" aria-label="Open in elaborat.ing" title="Open in elaborat.ing" className={buttonVariants({ variant: "ghost", size: "sm" })}>
            <ExternalLink data-icon="inline-start" aria-hidden="true" />
            <span className="max-sm:hidden">Open in elaborat.ing</span>
          </a>
          {email !== undefined && (
            <AccountPill
              email={email ?? "your account"}
              menu={[
                {
                  label: "Sign out",
                  onSelect: () => {
                    setError(null)
                    void signOut().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
                  },
                },
              ]}
            />
          )}
        </>
      }
      below={error && <Banner tone="danger">Not signed out: {error}</Banner>}
    />
  )
}

/** A short message in the middle of the panel. */
function Message({ children }: { children: ReactNode }) {
  return (
    <main className="flex justify-center px-3 py-6">
      <div className={cn(panel, "flex w-full max-w-[400px] flex-col items-start gap-3 p-5 text-sm")}>{children}</div>
    </main>
  )
}

function SignIn() {
  return (
    <main className="flex justify-center px-3 pt-2 pb-8">
      <Card className="h-fit w-full max-w-[400px] gap-5">
        <CardHeader>
          <CardTitle>
            <h1 className="text-[21px] leading-tight font-semibold">Sign in</h1>
          </CardTitle>
          <CardDescription className="text-[13px] leading-normal">This panel keeps its own sign-in.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <LoginForm next={null} embedded />
        </CardContent>
      </Card>
    </main>
  )
}

/** The page around the routes in a panel: the compact bar, then the projects, a project, or a way in. */
export function EmbedRoot() {
  useView()
  const account = useProjectAccount()
  const pass = usePass(account.kind === "account" ? account.account.userId : null)
  const href = useLocation({ select: (location) => location.href })
  const path = href.replace(/[?#].*$/, "")
  const onProject = path.startsWith("/projects/")
  // Whether the router shows the project's page yet. Until its code has
  // loaded the router still shows the home route, which is the site's home
  // page, so the panel keeps its own projects list until then.
  const projectShown = useRouterState({ select: (state) => state.matches.some((match) => match.routeId === "/projects/$projectId") })
  const url = new URL(path, window.location.origin).href
  useTellLocation(account.kind === "account" ? account.account : null, pass === "open" && onProject && projectShown ? href : null)

  let page: ReactNode
  if (path !== "/" && !onProject) {
    page = (
      <Message>
        <p>This page opens on the site.</p>
        <OpenOnSite url={url} className={buttonVariants()} />
      </Message>
    )
  } else if (account.kind === "loading") {
    page = (
      <Message>
        <p role="status" className="text-muted-foreground">
          Checking your session...
        </p>
      </Message>
    )
  } else if (account.kind === "unconfigured") {
    page = (
      <Message>
        <p role="alert">This copy of elaborat.ing is not connected to a Supabase project yet.</p>
      </Message>
    )
  } else if (account.kind === "signed-out") {
    page = <SignIn />
  } else if (pass === "checking") {
    page = (
      <Message>
        <p role="status" className="text-muted-foreground">
          Checking your session...
        </p>
      </Message>
    )
  } else if (pass === "closed") {
    // Opened without a pass this site's server gave the panel: nothing of the account shows.
    page = (
      <Message>
        <p>Open this from elaborat.ing in your ChatGPT sidebar.</p>
        <OpenOnSite url={url} className={buttonVariants()} />
      </Message>
    )
  } else {
    page = onProject && projectShown ? <Outlet /> : <ProjectsHome />
  }

  return (
    <DottedPage className="flex h-dvh min-h-0 flex-col overflow-hidden">
      <EmbedBar url={url} onProject={onProject && pass === "open"} email={account.kind === "account" ? account.account.email : undefined} />
      <div className="relative min-h-0 flex-1 overflow-y-auto">{page}</div>
      <ConfirmActionHost />
    </DottedPage>
  )
}
