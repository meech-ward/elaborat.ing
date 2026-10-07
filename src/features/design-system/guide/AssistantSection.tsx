import { ChevronLeft, MoreHorizontal } from "lucide-react"
import { useState, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { AssistantButton } from "../ui/AssistantButton"
import { AssistantPanel, AssistantSheet, ChatGPTPlanLabel, type AssistantBodyProps, type AssistantEntry, type AssistantStatus } from "../ui/AssistantPanel"
import { ChatGPTButton } from "../ui/ChatGPTButton"
import { CommentsButton } from "../ui/CommentMarker"
import { RoundIconButton } from "../ui/IconButton"
import { PhoneHeader } from "../ui/PhoneHeader"
import { phoneBleed } from "./c5Samples"
import { GuideGroup, GuideLabel, GuideValue } from "./parts"

// The Assistant card: the button that opens it, OpenAI's approved sign-in
// buttons, the panel in each of its states, and the phone's sheet. The
// assistant writes in the person's project on their ChatGPT plan; its
// states are the ones OpenAI's plan-usage guidelines ask for.

const noop = () => {}

const MODELS = [
  { slug: "model-a", name: "GPT Sample" },
  { slug: "model-b", name: "GPT Sample Mini" },
]

const CHAT: AssistantEntry[] = [
  { id: "u1", kind: "user", text: "Draw the sign-up flow, then add it to the plan." },
  { id: "s1", kind: "step", text: "Read", path: "notes/plan.mdx", state: "done" },
  { id: "s2", kind: "step", text: "Wrote", path: "art/flow.excalidraw", state: "done" },
  { id: "s3", kind: "step", text: "Writing", path: "notes/plan.mdx", state: "running" },
  { id: "a1", kind: "assistant", text: "The flow is drawn. Save it to keep it; I am adding it to the plan now." },
]

/** The body's props for a sample in `status`, with a composer that types. */
function useSample(status: AssistantStatus, entries: readonly AssistantEntry[] = [], extra: Partial<AssistantBodyProps> = {}): Omit<AssistantBodyProps, "size"> {
  const [draft, setDraft] = useState("")
  const [model, setModel] = useState<string | null>(MODELS[0].slug)
  return { status, entries, draft, onDraftChange: setDraft, onSend: () => setDraft(""), onStop: noop, models: MODELS, model, onModelChange: setModel, onConnect: noop, onRetry: noop, ...extra }
}

function PanelSample({ label, caption, children }: { label: string; caption: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <GuideLabel>{label}</GuideLabel>
      <div className="h-[520px]">{children}</div>
      <GuideValue>{caption}</GuideValue>
    </div>
  )
}

function PanelStates() {
  const chat = useSample("ready", CHAT, { running: true })
  const empty = useSample("ready")
  const loading = useSample("loading")
  const notConnected = useSample("not-connected")
  const notEligible = useSample("not-eligible")
  const limit = useSample("limit", CHAT.slice(0, 3))
  const unavailable = useSample("unavailable", CHAT.slice(0, 1))
  const reconnect = useSample("reconnect")
  const error = useSample("error", CHAT.slice(0, 1), { message: "ChatGPT could not answer. Try again." })
  const panel = (body: Omit<AssistantBodyProps, "size">) => <AssistantPanel headingLevel={4} className="h-full" onNewChat={noop} onClose={noop} {...body} />
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,360px),1fr))] gap-7">
      <PanelSample label="Working" caption="The person's message, the steps (Read, Wrote, Writing with a spinner) and the answer as it comes; Stop while it works. The model picker, then Using ChatGPT plan with Manage usage.">
        {panel(chat)}
      </PanelSample>
      <PanelSample label="New chat" caption="What it does, until the first message.">
        {panel(empty)}
      </PanelSample>
      <PanelSample label="Loading" caption="Checking the ChatGPT connection when it opens.">
        {panel(loading)}
      </PanelSample>
      <PanelSample label="Not connected" caption="Continue with ChatGPT, in the style that suits the theme.">
        {panel(notConnected)}
      </PanelSample>
      <PanelSample label="Needs Plus or Pro" caption="Plan usage is for Plus and Pro.">
        {panel(notEligible)}
      </PanelSample>
      <PanelSample label="Usage limit" caption="A compact card with the ChatGPT mark: Manage usage is the main action, and there are no credits to buy.">
        {panel(limit)}
      </PanelSample>
      <PanelSample label="Unavailable" caption="Plan usage could not be checked: try again later.">
        {panel(unavailable)}
      </PanelSample>
      <PanelSample label="Reconnect" caption="The connection stopped working (a refresh was refused).">
        {panel(reconnect)}
      </PanelSample>
      <PanelSample label="Error" caption="Anything else, with what ChatGPT said.">
        {panel(error)}
      </PanelSample>
    </div>
  )
}

function SheetSample() {
  const [frame, setFrame] = useState<HTMLDivElement | null>(null)
  const pictured = useSample("ready", CHAT)
  const live = useSample("ready", CHAT)
  const [open, setOpen] = useState(false)
  return (
    <div className="flex w-full max-w-[390px] flex-col gap-3">
      <GuideLabel>Phone, assistant sheet</GuideLabel>
      <div inert className={cn("relative h-[844px] w-full max-w-[390px] overflow-hidden rounded-panel border border-border bg-panel", phoneBleed)}>
        <PhoneHeader
          back={
            <RoundIconButton label="Back to files and projects">
              <ChevronLeft />
            </RoundIconButton>
          }
        >
          <CommentsButton size="touch" count={0} />
          <AssistantButton size="touch" pressed busy />
          <RoundIconButton label="File actions">
            <MoreHorizontal />
          </RoundIconButton>
        </PhoneHeader>
        <div className="absolute inset-x-0 top-16 flex flex-col gap-3.5 px-[22px]">
          <p className="text-[30px] leading-[1.15] font-bold">Sign-up flow</p>
          <p className="text-[15.5px] leading-[1.6] text-body">How a new account starts, from the landing page to the first project.</p>
        </div>
        <div ref={setFrame} className="absolute inset-0" />
        {frame && (
          <AssistantSheet open inert modal={false} onOpenChange={noop} container={frame} className="absolute data-[side=bottom]:h-[600px]" overlayClassName="absolute" {...pictured} />
        )}
      </div>
      <GuideValue>
        shadcn&apos;s Sheet from the bottom, 75% of the screen, as the comments&apos; sheet: 15px text, 40px targets. It closes while a file is written, so the file shows; the button&apos;s dot says the assistant is still working.
      </GuideValue>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" className="pointer-coarse:h-10" onClick={() => setOpen(true)}>
          Open the assistant sheet
        </Button>
        <GuideValue>The live sheet, over this page</GuideValue>
      </div>
      <AssistantSheet open={open} onOpenChange={setOpen} onNewChat={noop} {...live} />
    </div>
  )
}

export function AssistantSection() {
  return (
    <GuideGroup title="On a ChatGPT plan">
      <GuideValue>
        The assistant writes notes, drawings and diagrams in the open project on the person&apos;s ChatGPT plan, beside the file where the comments go. The ChatGPT mark is OpenAI&apos;s, used under its brand guidelines.
      </GuideValue>
      <GuideLabel>Assistant button</GuideLabel>
      <div className="flex flex-wrap items-center gap-3">
        <AssistantButton />
        <AssistantButton pressed />
        <AssistantButton busy />
        <AssistantButton size="touch" />
        <AssistantButton size="touch" busy />
      </div>
      <GuideValue>In the editor&apos;s top line beside the comments; seg while open; the accent dot while it works, also when closed. The phone&apos;s round button.</GuideValue>
      <GuideLabel>Continue with ChatGPT</GuideLabel>
      <div className="flex flex-wrap items-center gap-3">
        <ChatGPTButton tone="black" />
        <ChatGPTButton tone="white" />
        <ChatGPTButton tone="black" action="sign-in" />
        <ChatGPTButton tone="white" action="sign-in" />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <ChatGPTButton />
        <GuideValue>auto: black on a light page, white on a dark one</GuideValue>
      </div>
      <GuideValue>OpenAI&apos;s four approved buttons: 45 high, radius 12, 20 either side, the mark at 21, 15px medium text.</GuideValue>
      <GuideLabel>Using ChatGPT plan</GuideLabel>
      <ChatGPTPlanLabel />
      <GuideValue>Under the composer whenever the plan is in use; Manage usage opens ChatGPT&apos;s usage settings.</GuideValue>
      <PanelStates />
      <SheetSample />
    </GuideGroup>
  )
}
