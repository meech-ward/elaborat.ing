import type { Page, Request, Route, WebSocketRoute } from "@playwright/test"
import { FakeProjectServer } from "../../src/features/project-storage/fakeServer.ts"
import { RemoteError } from "../../src/features/project-storage/remote.ts"

/**
 * A stand-in for the Supabase project the browser-test build points at
 * (http://127.0.0.1:54321, see .env.browser-test). Auth, the project
 * functions, the table reads sync makes and Realtime are answered here; the
 * project data lives in the same in-memory server the unit tests use.
 */

export const SUPABASE = "http://127.0.0.1:54321"
export const person = {
  id: "0b6a4a52-6f3e-4c1a-9d59-3b7f1c2a9e01",
  aud: "authenticated",
  role: "authenticated",
  email: "person@example.com",
  app_metadata: { provider: "email" },
  user_metadata: {},
  created_at: "2026-09-26T00:00:00Z",
}
export const session = () => ({
  access_token: "header.eyJzdWIiOiIwYjZhNGE1MiJ9.signature",
  token_type: "bearer",
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  refresh_token: "refresh-token",
  user: person,
})

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
  "access-control-expose-headers": "*",
}

type Options = {
  server?: FakeProjectServer
  /** Answer the consent step of an OAuth request with this redirect. */
  consentRedirect?: string
  /** The agents (OAuth grants) the person has approved; listing fails when this is "error". */
  grants?: OAuthGrant[] | "error"
}

/** An approved agent, as Supabase Auth lists it. */
export type OAuthGrant = { client: { id: string; name: string; uri: string; logo_uri: string }; scopes: string[]; granted_at: string }

export type FakeSupabase = {
  server: FakeProjectServer
  requests: Request[]
  /** Requests refused while offline. */
  refused: Request[]
  /** While true, every request fails as if the network were down. */
  offline: boolean
  /** Push a change signal for a project over Realtime. */
  signal(projectId: string, revision: number): void
}

const errorStatus: Record<RemoteError["kind"], number> = { network: 503, access: 403, archived: 409, limit: 409, "path-taken": 409, invalid: 400, unavailable: 403 }
const errorCode: Record<RemoteError["kind"], string> = { network: "", access: "42501", archived: "55000", limit: "54000", "path-taken": "23505", invalid: "22023", unavailable: "42501" }

/** Answer Supabase for `page`, as `person`. */
export async function fakeSupabase(page: Page, options: Options = {}): Promise<FakeSupabase> {
  const server = options.server ?? new FakeProjectServer()
  const remote = server.remote(person.id)
  const sockets: WebSocketRoute[] = []
  const fake: FakeSupabase = {
    server,
    requests: [],
    refused: [],
    offline: false,
    signal(projectId, revision) {
      for (const socket of sockets) {
        socket.send(JSON.stringify([null, null, `realtime:project:${projectId}`, "broadcast", { type: "broadcast", event: "changed", payload: { revision } }]))
      }
    },
  }
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, headers: CORS, contentType: "application/json", body: JSON.stringify(body) })

  const answer = async (route: Route, work: () => Promise<unknown>) => {
    try {
      return await json(route, (await work()) ?? null)
    } catch (error) {
      if (!(error instanceof RemoteError)) throw error
      if (error.kind === "network") return route.abort("internetdisconnected")
      const message = error.kind === "unavailable" ? "Project unavailable" : error.message
      return json(route, { code: errorCode[error.kind], message, details: error.detail, hint: null }, errorStatus[error.kind])
    }
  }

  await page.route(`${SUPABASE}/**`, async (route) => {
    const request = route.request()
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS })
    if (fake.offline) {
      fake.refused.push(request)
      return route.abort("internetdisconnected")
    }
    fake.requests.push(request)
    const url = new URL(request.url())
    const path = url.pathname
    const query = (name: string, op: string) => {
      const value = url.searchParams.getAll(name).find((entry) => entry.startsWith(`${op}.`))
      return value === undefined ? undefined : value.slice(op.length + 1)
    }

    // Auth
    if (path.startsWith("/auth/v1/")) {
      if (path.endsWith("/token")) return json(route, session())
      if (path.endsWith("/user")) return json(route, person)
      if (path.endsWith("/otp")) return json(route, {})
      if (path.endsWith("/logout")) return route.fulfill({ status: 204, headers: CORS })
      if (path.endsWith("/oauth/authorizations/auth-123")) {
        return json(route, {
          authorization_id: "auth-123",
          redirect_uri: "https://claude.ai/api/mcp/auth_callback",
          client: { id: "client-1", name: "Claude", uri: "https://claude.ai", logo_uri: "" },
          user: { id: person.id, email: person.email },
          scope: "openid email",
        })
      }
      if (path.endsWith("/oauth/authorizations/auth-123/consent") && options.consentRedirect) return json(route, { redirect_url: options.consentRedirect })
      if (path.endsWith("/user/oauth/grants")) {
        if (options.grants === "error") return json(route, { code: 500, error_code: "unexpected_failure", msg: "Grants are unavailable" }, 500)
        const grants = options.grants ?? []
        if (request.method() === "DELETE") {
          const clientId = url.searchParams.get("client_id")
          const index = grants.findIndex((grant) => grant.client.id === clientId)
          if (index === -1) return json(route, { code: 404, error_code: "oauth_client_not_found", msg: "No grant for that client" }, 404)
          grants.splice(index, 1)
          return route.fulfill({ status: 204, headers: CORS })
        }
        return json(route, grants)
      }
      return json(route, { msg: `No fake for ${request.method()} ${path}` }, 404)
    }

    // Project functions
    const rpc = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(path)?.[1]
    if (rpc) {
      const body = request.postDataJSON() ?? {}
      if (rpc === "list_projects") return answer(route, () => remote.listProjects())
      if (rpc === "create_project") return answer(route, () => remote.createProject(body.project_id, body.title))
      if (rpc === "rename_project") return answer(route, () => remote.renameProject(body.project_id, body.title))
      if (rpc === "save_files") return answer(route, () => remote.saveFiles(body.project_id, body.mutation_id, body.changes))
      if (rpc === "list_invitations") return answer(route, () => remote.listInvitations())
      if (rpc === "accept_invitation") return answer(route, () => remote.acceptInvitation(body.project_id))
      if (rpc === "leave_project") return answer(route, async () => (await remote.leaveProject(body.project_id), { project_id: body.project_id, left: true }))
      if (rpc === "archive_project") return answer(route, () => remote.archiveProject(body.project_id))
      if (rpc === "unarchive_project") return answer(route, () => remote.unarchiveProject(body.project_id))
      if (rpc === "delete_project") return answer(route, async () => (await remote.deleteProject(body.project_id), { id: body.project_id, deleted: true }))
    }

    // Table reads (everything fits in the first page here)
    if (url.searchParams.has("or") || (path.endsWith("/project_folders") && query("path", "gt") !== undefined)) return json(route, [])
    const projectId = query("project_id", "eq")
    if (projectId && path.endsWith("/project_files")) {
      return answer(route, () => remote.changedFiles(projectId, Number(query("version", "gt")), Number(query("version", "lte"))))
    }
    if (projectId && path.endsWith("/file_versions")) {
      return answer(route, async () =>
        (await remote.deletedFiles(projectId, Number(query("version", "gt")), Number(query("version", "lte")))).map((row) => ({ file_id: row.id, version: row.version })),
      )
    }
    if (projectId && path.endsWith("/project_folders")) return answer(route, async () => (await remote.folders(projectId)).map((folder) => ({ path: folder })))
    return json(route, { message: `No fake for ${request.method()} ${path}${url.search}` }, 404)
  })

  // Realtime (protocol 2.0.0: each text frame is [join_ref, ref, topic, event, payload]).
  await page.routeWebSocket(/\/realtime\/v1\/websocket/, (socket) => {
    sockets.push(socket)
    socket.onMessage((message) => {
      if (typeof message !== "string") return
      const [joinRef, ref, topic, event] = JSON.parse(message) as [string | null, string | null, string, string, unknown]
      if (event === "phx_join" || event === "heartbeat" || event === "access_token") {
        socket.send(JSON.stringify([joinRef, ref, topic, "phx_reply", { status: "ok", response: {} }]))
      }
    })
  })
  return fake
}

/** Start the page already signed in as `person`. */
export async function signedIn(page: Page) {
  await page.addInitScript((stored) => {
    localStorage.setItem("sb-127-auth-token", stored)
  }, JSON.stringify(session()))
}

/** Wait until the page has made no request, answered or refused, for `ms`. */
export async function quiet(fake: FakeSupabase, ms = 500) {
  let count = -1
  while (count !== fake.requests.length + fake.refused.length) {
    count = fake.requests.length + fake.refused.length
    await new Promise((resolve) => setTimeout(resolve, ms))
  }
}
