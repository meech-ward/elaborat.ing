import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { AssistantPanel, AssistantSheet, ChatGPTMark, confirmAction, type AssistantBodyProps } from "@/features/design-system"
import { connectPlan, fetchPlanStatus, KeeperError } from "./api"
import { chatFor } from "./chat"
import { statusOf, type Connection } from "./status"
import type { AssistantProps } from "./LazyAssistant"
import { cn } from "@/lib/utils"
import { liveDriver } from "./live"

// The assistant's panel (desktop) or sheet (phone), its chat, and the plan's
// required notices: the first-time "You're using your ChatGPT plan", "Using
// ChatGPT plan" with Manage usage, and the plan's error states. Loaded the
// first time the assistant opens (LazyAssistant.tsx).

const MODEL_KEY = "elaborating:assistant-model"
const WELCOMED_KEY = "elaborating:chatgpt-plan-welcomed"

const readStored = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}
const store = (key: string, value: string) => {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Storage unavailable: it is asked again next time.
  }
}

export function AssistantView({ host, compact, open, onOpenChange, onBusyChange, className }: AssistantProps) {
  const chat = chatFor(host.projectId)
  const state = useSyncExternalStore(chat.subscribe, chat.get)
  const [connection, setConnection] = useState<Connection>({ kind: "loading" })
  const [attempt, setAttempt] = useState(0)
  const [draft, setDraft] = useState("")
  const [connecting, setConnecting] = useState(false)
  const [chosen, setChosen] = useState<string | null>(() => readStored(MODEL_KEY))
  const [welcomed, setWelcomed] = useState(() => readStored(WELCOMED_KEY) === "1")
  const live = useMemo(() => liveDriver(() => host.liveContainer()), [host])

  // The connection is checked each time the panel opens (and on Try again).
  useEffect(() => {
    if (!open) return
    let alive = true
    fetchPlanStatus().then(
      (status) => alive && setConnection({ kind: "ready", status }),
      (error: unknown) => alive && setConnection({ kind: "failed", error: error instanceof KeeperError ? error.planError : { error: "error", message: String(error) } }),
    )
    return () => {
      alive = false
    }
  }, [open, attempt])

  useEffect(() => onBusyChange(state.running), [state.running, onBusyChange])
  // Leaving the project stops a turn that is still running; the chat stays for when the person comes back.
  useEffect(() => () => chat.stop(), [chat])

  // On a phone the sheet gets out of the way while a file is written, so the file shows.
  const writing = state.writing
  useEffect(() => {
    if (compact && writing) onOpenChange(false)
  }, [compact, writing, onOpenChange])

  const models = connection.kind === "ready" ? connection.status.models : []
  const model = models.find((entry) => entry.slug === chosen)?.slug ?? models[0]?.slug ?? null
  const shown = statusOf(connection, state.problem)
  const ready = connection.kind === "ready" && connection.status.connected && connection.status.plan && !connection.status.problem

  const connect = useCallback(() => {
    setConnecting(true)
    const planOff = connection.kind === "ready" && connection.status.connected && !connection.status.plan
    connectPlan(planOff).catch((error: unknown) => {
      setConnecting(false)
      setConnection({ kind: "failed", error: error instanceof KeeperError ? error.planError : { error: "error", message: String(error) } })
    })
  }, [connection])

  const send = () => {
    const text = draft.trim()
    if (!text || !model) return
    setDraft("")
    void chat.send(text, { model, host, confirm: (message) => confirmAction(message, { confirmLabel: "Replace" }), live })
  }

  const body: Omit<AssistantBodyProps, "size"> = {
    ...shown,
    entries: state.entries,
    running: state.running,
    draft,
    onDraftChange: setDraft,
    onSend: send,
    onStop: () => chat.stop(),
    models,
    model,
    onModelChange: (slug) => {
      setChosen(slug)
      store(MODEL_KEY, slug)
    },
    onConnect: connect,
    connecting,
    onRetry: () => setAttempt((value) => value + 1),
    readOnly: host.readOnly,
    announcement: state.announcement,
  }

  const welcome = (
    <Dialog
      open={open && ready && !welcomed}
      onOpenChange={(next) => {
        if (next) return
        setWelcomed(true)
        store(WELCOMED_KEY, "1")
      }}
    >
      <DialogContent showCloseButton={false} className="sm:max-w-sm">
        <DialogHeader className="items-center text-center sm:items-center sm:text-center">
          <ChatGPTMark className="size-9" />
          <DialogTitle>You&apos;re using your ChatGPT plan</DialogTitle>
          <DialogDescription>
            What you ask the assistant in elaborat.ing uses your ChatGPT plan. You can manage its usage in ChatGPT settings.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            className="w-full"
            onClick={() => {
              setWelcomed(true)
              store(WELCOMED_KEY, "1")
            }}
          >
            Got it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )

  if (compact)
    return (
      <>
        <AssistantSheet open={open} onOpenChange={onOpenChange} onNewChat={() => chat.newChat()} {...body} />
        {welcome}
      </>
    )
  if (!open) return null
  return (
    <>
      <AssistantPanel
        render={<aside aria-label="Assistant" />}
        headingLevel={2}
        className={cn("h-full shrink-0", className)}
        onNewChat={() => chat.newChat()}
        onClose={() => onOpenChange(false)}
        {...body}
      />
      {welcome}
    </>
  )
}
