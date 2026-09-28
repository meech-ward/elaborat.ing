import type { Page, Request, Route, WebSocketRoute } from "@playwright/test"
import { accountName } from "../../src/features/auth/accountName.ts"
import { FakeProjectServer } from "../../src/features/project-storage/fakeServer.ts"
import { RemoteError } from "../../src/features/project-storage/remote.ts"
import { FakeComments } from "./fake-comments.ts"

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

/** The one-time code the stand-in Auth accepts for `person`. */
export const otpCode = "123456"

type Options = {
  server?: FakeProjectServer
  /** Sign-in providers Auth reports on in its public settings. */
  providers?: { github?: boolean; google?: boolean }
  /** Answer the consent step of an OAuth request with this redirect. */
  consentRedirect?: string
  /** The agents (OAuth grants) the person has approved; listing fails when this is "error". */
  grants?: OAuthGrant[] | "error"
  /** Whether Auth reports passkey sign-in on (see `FakeSupabase.passkeys`). */
  passkeys?: boolean
}

/** A passkey the stand-in Auth registered for `person`, with the browser's credential id. */
export type FakePasskey = { id: string; friendly_name: string; created_at: string; last_used_at?: string; credentialId: string }

// The relying party the stand-in Auth names: WebAuthn needs a domain, so
// passkey journeys open the app at localhost rather than 127.0.0.1.
const RP_ID = "localhost"
const base64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url")

/** An approved agent, as Supabase Auth lists it. */
export type OAuthGrant = { client: { id: string; name: string; uri: string; logo_uri: string }; scopes: string[]; granted_at: string }

export type FakeSupabase = {
  server: FakeProjectServer
  /** The comment functions, over the server's projects; `comments.call(user, rpc, args)` writes as someone else. */
  comments: FakeComments
  requests: Request[]
  /** Requests refused while offline. */
  refused: Request[]
  /** The passkeys registered through the stand-in Auth, which accepts any credential it registered. */
  passkeys: FakePasskey[]
  /** While true, every request fails as if the network were down. */
  offline: boolean
  /** Push a change signal for a project over Realtime. */
  signal(projectId: string, revision: number): void
}

const errorStatus: Record<RemoteError["kind"], number> = { network: 503, access: 403, archived: 409, limit: 409, "account-limit": 429, "path-taken": 409, invalid: 400, unavailable: 403 }
const errorCode: Record<RemoteError["kind"], string> = { network: "", access: "42501", archived: "55000", limit: "54000", "account-limit": "PT429", "path-taken": "23505", invalid: "22023", unavailable: "42501" }

/** Answer Supabase for `page`, as `person`. */
export async function fakeSupabase(page: Page, options: Options = {}): Promise<FakeSupabase> {
  const server = options.server ?? new FakeProjectServer()
  server.emails.set(person.id, person.email)
  const remote = server.remote(person.id)
  const sockets: WebSocketRoute[] = []
  // The person's user metadata, which Settings changes (their name).
  let metadata: Record<string, unknown> = { ...person.user_metadata }
  const me = () => ({ ...person, user_metadata: metadata })
  const fake: FakeSupabase = {
    server,
    comments: new FakeComments(server),
    requests: [],
    refused: [],
    passkeys: [],
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
      if (path.endsWith("/token")) return json(route, { ...session(), user: me() })
      if (path.endsWith("/user")) {
        const { data } = request.method() === "PUT" ? (request.postDataJSON() ?? {}) : {}
        if (data && typeof data === "object") {
          metadata = { ...metadata, ...data }
          // Comments and members name the person as the database would.
          const name = accountName(metadata)
          if (name) server.names.set(person.id, name)
          else server.names.delete(person.id)
        }
        return json(route, me())
      }
      if (path.endsWith("/otp")) return json(route, {})
      if (path.endsWith("/settings")) {
        return json(route, {
          external: { email: true, github: options.providers?.github ?? false, google: options.providers?.google ?? false },
          disable_signup: false,
          passkeys_enabled: options.passkeys ?? false,
        })
      }
      // Passkeys: the WebAuthn options Auth sends, and what it answers once
      // the browser's authenticator has signed them.
      const challenge = { challenge_id: crypto.randomUUID(), expires_at: Math.floor(Date.now() / 1000) + 300 }
      if (path.endsWith("/passkeys/registration/options")) {
        return json(route, {
          ...challenge,
          options: {
            challenge: base64url(crypto.getRandomValues(new Uint8Array(32))),
            rp: { id: RP_ID, name: "elaborat.ing" },
            user: { id: base64url(new TextEncoder().encode(person.id)), name: person.email, displayName: person.email },
            pubKeyCredParams: [{ type: "public-key", alg: -7 }],
            authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
            excludeCredentials: fake.passkeys.map((passkey) => ({ type: "public-key", id: passkey.credentialId })),
            attestation: "none",
            timeout: 60_000,
          },
        })
      }
      if (path.endsWith("/passkeys/registration/verify")) {
        const { credential } = request.postDataJSON() ?? {}
        const passkey = { id: crypto.randomUUID(), friendly_name: "Test authenticator", created_at: new Date().toISOString(), credentialId: String(credential?.id) }
        fake.passkeys.push(passkey)
        return json(route, { id: passkey.id, friendly_name: passkey.friendly_name, created_at: passkey.created_at })
      }
      if (path.endsWith("/passkeys/authentication/options")) {
        return json(route, { ...challenge, options: { challenge: base64url(crypto.getRandomValues(new Uint8Array(32))), rpId: RP_ID, userVerification: "preferred", timeout: 60_000 } })
      }
      if (path.endsWith("/passkeys/authentication/verify")) {
        const { credential } = request.postDataJSON() ?? {}
        const passkey = fake.passkeys.find((entry) => entry.credentialId === credential?.id)
        // Auth answers a credential it has no record of as a failed verification.
        if (!passkey) return json(route, { code: 400, error_code: "webauthn_verification_failed", msg: "Credential verification failed" }, 400)
        passkey.last_used_at = new Date().toISOString()
        return json(route, session())
      }
      if (path.endsWith("/passkeys") && request.method() === "GET") {
        return json(route, fake.passkeys.map(({ id, friendly_name, created_at, last_used_at }) => ({ id, friendly_name, created_at, last_used_at })))
      }
      const removed = /\/passkeys\/([^/]+)$/.exec(path)?.[1]
      if (removed && request.method() === "DELETE") {
        fake.passkeys = fake.passkeys.filter((passkey) => passkey.id !== removed)
        return route.fulfill({ status: 204, headers: CORS })
      }
      if (path.endsWith("/verify")) {
        const body = request.postDataJSON() ?? {}
        if (body.email === person.email && body.token === otpCode) return json(route, session())
        return json(route, { code: 403, error_code: "otp_expired", msg: "Token has expired or is invalid" }, 403)
      }
      // A provider sign-in starts with the browser going to Auth's authorize URL.
      if (path.endsWith("/authorize")) return route.fulfill({ status: 200, contentType: "text/html", body: "<title>Provider sign-in</title>" })
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
      if (rpc === "list_members") return answer(route, () => remote.listMembers(body.project_id))
      if (FakeComments.handles(rpc)) return answer(route, async () => fake.comments.call(person.id, rpc, body))
      if (rpc === "share_project") {
        return answer(route, async () => (
          await remote.shareProject(body.project_id, body.member_id, body.member_role),
          { project_id: body.project_id, member_id: body.member_id, role: body.member_role }
        ))
      }
    }

    // The share Edge Function: invite an email, with or without an account.
    if (path === "/functions/v1/share") {
      const { projectId, email, role } = request.postDataJSON() ?? {}
      try {
        await remote.inviteByEmail(projectId, email, role)
        return await json(route, { projectId, email, role })
      } catch (error) {
        if (!(error instanceof RemoteError)) throw error
        if (error.kind === "network") return route.abort("internetdisconnected")
        return json(route, { error: error.message }, error.kind === "access" || error.kind === "account-limit" ? errorStatus[error.kind] : 400)
      }
    }

    // The search Edge Function: a passage for each file, in the projects the
    // person can read (or the one asked for), whose text has every word of the query.
    if (path === "/functions/v1/search") {
      // Over a per-account limit, the function answers 429 with the database's message.
      if (server.limited) return json(route, { error: server.limited }, 429)
      const { query: text, projectId: onlyProject } = request.postDataJSON() ?? {}
      const words = String(text ?? "").toLowerCase().split(/\s+/).filter(Boolean)
      const results = [...server.projects.values()]
        .filter((project) => project.owner === person.id || project.members.get(person.id)?.acceptedAt)
        .filter((project) => !onlyProject || project.id === onlyProject)
        .flatMap((project) =>
          [...project.files.values()]
            .filter((file) => words.every((word) => file.content.toLowerCase().includes(word)))
            .map((file) => ({ project_id: project.id, file_id: file.id, path: file.path, headings: "", content: file.content, score: 1 })),
        )
      return json(route, { results })
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
  // Init scripts run in every frame; the rendered note's sandboxed frame has
  // no storage, and reading it there throws.
  await page.addInitScript((stored) => {
    if (window === window.top) localStorage.setItem("sb-127-auth-token", stored)
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
