// Temporary host capability probe, remove after testing (with its route,
// src/routes/embed-probe.tsx, and the /embed-probe part of vite.config.ts).
//
// It reports what the app has in this browser: who frames it, which storage
// works and is still there after a reload, whether the service worker runs,
// whether the person's session is visible, and whether signing in with an
// emailed code works. Like every other page it may not be framed
// (X-Frame-Options DENY), and it posts nothing to other windows.
import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { DottedPage, panel } from "@/components/panel"
import { Banner } from "@/features/design-system"
import { EmailCodeStep, sendSignInEmail, signOut, useAuth } from "@/features/auth"
import { cn } from "@/lib/utils"

const KEY = "elaborating-embed-probe"
const PATH = "/embed-probe"

type Check = { value: string; ok: boolean | null }
const ok = (value: string): Check => ({ value, ok: true })
const bad = (value: string): Check => ({ value, ok: false })
const plain = (value: string): Check => ({ value, ok: null })

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

function framed(): boolean {
  try {
    return window.top !== window
  } catch {
    return true
  }
}

function ancestors(): string[] | null {
  return location.ancestorOrigins ? Array.from(location.ancestorOrigins) : null
}

/** What this load writes, so a later load can say where it was written. */
function mark(): string {
  return JSON.stringify({ at: new Date().toISOString(), in: ancestors()?.at(-1) ?? (framed() ? "a frame" : "the top window") })
}

function earlier(raw: string | null | undefined): string {
  if (!raw) return "nothing from an earlier load"
  try {
    const found = JSON.parse(raw) as { at?: string; in?: string }
    return `kept from ${found.at} (${found.in})`
  } catch {
    return `kept from ${raw}`
  }
}

function webStorage(get: () => Storage): Check {
  try {
    const storage = get()
    const before = storage.getItem(KEY)
    const next = mark()
    storage.setItem(KEY, next)
    return storage.getItem(KEY) === next ? ok(`works; ${earlier(before)}`) : bad(`write not kept; ${earlier(before)}`)
  } catch (error) {
    return bad(`blocked (${describe(error)})`)
  }
}

function indexedDbCheck(): Promise<Check> {
  const work = new Promise<Check>((resolve) => {
    try {
      const request = indexedDB.open(KEY, 1)
      request.onupgradeneeded = () => request.result.createObjectStore("marks")
      request.onerror = () => resolve(bad(`blocked (${describe(request.error)})`))
      request.onsuccess = () => {
        const db = request.result
        const transaction = db.transaction("marks", "readwrite")
        const store = transaction.objectStore("marks")
        const read = store.get("last")
        read.onsuccess = () => {
          const before = typeof read.result === "string" ? read.result : null
          store.put(mark(), "last")
          transaction.oncomplete = () => {
            db.close()
            resolve(ok(`works; ${earlier(before)}`))
          }
        }
        transaction.onerror = () => resolve(bad(`blocked (${describe(transaction.error)})`))
      }
    } catch (error) {
      resolve(bad(`blocked (${describe(error)})`))
    }
  })
  const timeout = new Promise<Check>((resolve) => setTimeout(() => resolve(bad("no answer in 5 s")), 5000))
  return Promise.race([work, timeout])
}

function cookieCheck(name: string, attributes: string): Check {
  const read = () => document.cookie.split("; ").find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1)
  const before = read()
  const value = encodeURIComponent(new Date().toISOString())
  try {
    document.cookie = `${name}=${value}; Path=${PATH}; Max-Age=86400; Secure; SameSite=None${attributes}`
  } catch (error) {
    return bad(`blocked (${describe(error)})`)
  }
  const kept = before ? `kept from ${decodeURIComponent(before)}` : "nothing from an earlier load"
  return read() === value ? ok(`works; ${kept}`) : bad(`not kept; ${kept}`)
}

async function serviceWorkerCheck(): Promise<Check> {
  if (!("serviceWorker" in navigator)) return bad("not available")
  try {
    const registration = await navigator.serviceWorker.getRegistration()
    if (navigator.serviceWorker.controller) return ok("active, controls this page")
    if (registration?.active) return ok("active, not controlling this page yet")
    if (registration) return plain("registered, not active yet")
    return plain("not registered")
  } catch (error) {
    return bad(`blocked (${describe(error)})`)
  }
}

async function storageAccessCheck(): Promise<Check> {
  if (typeof document.hasStorageAccess !== "function") return plain("the browser has no Storage Access API")
  try {
    return (await document.hasStorageAccess()) ? ok("has access to this site's own storage") : plain("no access (storage is kept apart for this frame)")
  } catch (error) {
    return bad(`blocked (${describe(error)})`)
  }
}

type Checks = Record<string, Check>

function useChecks(): [Checks, (name: string, check: Check) => void] {
  const [checks, setChecks] = useState<Checks>({})
  const update = (name: string, check: Check) => setChecks((current) => ({ ...current, [name]: check }))
  const started = useRef(false)
  useEffect(() => {
    // Once per load: each run writes new marks.
    if (started.current) return
    started.current = true
    const origins = ancestors()
    update("framed", plain(framed() ? "yes" : "no, this is the top window"))
    update("ancestor origins", origins ? plain(origins.join(", ") || "(none)") : plain("this browser does not list them"))
    update("referrer", plain(document.referrer ? new URL(document.referrer).origin : "(none)"))
    update("localStorage", webStorage(() => window.localStorage))
    update("sessionStorage", webStorage(() => window.sessionStorage))
    update("cookie", cookieCheck("embed_probe", ""))
    update("cookie (partitioned)", cookieCheck("embed_probe_partitioned", "; Partitioned"))
    void indexedDbCheck().then((check) => update("IndexedDB", check))
    void storageAccessCheck().then((check) => update("storage access", check))
    void serviceWorkerCheck().then((check) => update("service worker", check))
    // The app registers its worker once the page has loaded, so look again.
    const later = setTimeout(() => void serviceWorkerCheck().then((check) => update("service worker", check)), 6000)
    return () => clearTimeout(later)
  }, [])
  return [checks, update]
}

/** The session line, shown on this page only. */
function sessionCheck(auth: ReturnType<typeof useAuth>): Check {
  switch (auth.status) {
    case "ready":
      return ok(`signed in${auth.email ? ` as ${auth.email}` : ""}`)
    case "signed-out":
      return plain("not signed in")
    case "loading":
      return plain("checking")
    case "error":
      return bad(auth.message)
    default:
      return bad("this copy has no Supabase project")
  }
}

/** Asks the browser for this site's own storage, and looks for a saved session there (without reading it). */
async function requestAccess(): Promise<Check> {
  try {
    const request = document.requestStorageAccess as unknown as (types?: { localStorage: boolean }) => Promise<{ localStorage?: Storage } | undefined>
    const handle = await request.call(document, { localStorage: true })
    const storage = handle?.localStorage
    if (!storage) return ok("granted (cookies only in this browser)")
    const saved = Object.keys(storage).some((key) => key.startsWith("sb-") && key.endsWith("-auth-token"))
    return ok(`granted; a saved session is ${saved ? "there" : "not there"} in this site's own storage`)
  } catch (error) {
    return bad(`refused (${describe(error)})`)
  }
}

function SignIn() {
  const [email, setEmail] = useState("")
  const [sent, setSent] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (sent) return <EmailCodeStep email={email} next={PATH} onBack={() => setSent(false)} />
  const send = async (event: React.FormEvent) => {
    event.preventDefault()
    setSending(true)
    setError(null)
    const { error } = await sendSignInEmail(email, PATH)
    setSending(false)
    if (error) setError(error.message)
    else setSent(true)
  }
  return (
    <form onSubmit={send} className="flex flex-col gap-3">
      <div className="grid gap-2">
        <Label htmlFor="probe-email">Email</Label>
        <Input id="probe-email" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
      </div>
      {error ? <Banner tone="danger">{error}</Banner> : null}
      <Button type="submit" disabled={sending}>
        {sending ? "Sending..." : "Email me a sign-in code"}
      </Button>
    </form>
  )
}

export function EmbedProbePage() {
  const auth = useAuth()
  const [checks, update] = useChecks()
  const [copied, setCopied] = useState<string | null>(null)
  const report = useRef<HTMLTextAreaElement>(null)
  const session = sessionCheck(auth)
  const rows: [string, Check][] = [...Object.entries(checks), ["session", session]]
  const text = [`elaborat.ing embed probe, ${new Date().toISOString().slice(0, 16)}`, ...rows.map(([name, check]) => `${name}: ${check.value}`)].join("\n")

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied("Copied.")
    } catch {
      report.current?.focus()
      report.current?.select()
      setCopied("Selected. Copy it with your keyboard or menu.")
    }
  }

  return (
    <DottedPage className="px-3 py-4 sm:px-4 sm:py-8">
      <main className={cn(panel, "mx-auto flex w-full max-w-[560px] flex-col gap-4 p-4 text-sm")}>
        <div>
          <h1 className="text-[17px] font-semibold">Embed probe</h1>
          <p className="text-muted-foreground">A temporary test of this page inside another site&apos;s frame.</p>
        </div>
        <dl className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-x-3 gap-y-1.5">
          {rows.map(([name, check]) => (
            <div key={name} className="contents">
              <dt className="text-muted-foreground">{name}</dt>
              <dd className={cn("[overflow-wrap:anywhere]", check.ok === true && "text-ok", check.ok === false && "text-danger")}>{check.value}</dd>
            </div>
          ))}
        </dl>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => location.reload()}>
            Reload
          </Button>
          {typeof document.requestStorageAccess === "function" && (
            <Button variant="outline" onClick={() => void requestAccess().then((check) => update("storage access request", check))}>
              Ask for storage access
            </Button>
          )}
          {auth.status === "ready" && (
            <Button variant="outline" onClick={() => void signOut()}>
              Sign out
            </Button>
          )}
        </div>
        {auth.status === "signed-out" && (
          <section className="flex flex-col gap-2">
            <h2 className="font-semibold">Sign in here</h2>
            <SignIn />
          </section>
        )}
        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-semibold">Report</h2>
            <Button variant="outline" size="sm" onClick={() => void copy()}>
              Copy report
            </Button>
          </div>
          <Textarea ref={report} readOnly value={text} aria-label="Report" className="min-h-40 font-mono text-xs" />
          {copied && <p className="text-muted-foreground">{copied}</p>}
        </section>
      </main>
    </DottedPage>
  )
}
