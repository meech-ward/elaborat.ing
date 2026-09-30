import { useState } from "react"
import { Button } from "@/components/ui/button"
import { AgentChangeRow } from "../ui/AgentChangeRow"
import { AgentChangesButton, CountBadge } from "../ui/AgentChangesButton"
import { DiffBlock } from "../ui/DiffBlock"
import { ProjectHeader } from "../ui/ProjectHeader"
import { NOW } from "./commentSamples"
import { GuideGroup, GuideLabel, GuideValue } from "./parts"

// The Agent changes card: the count badge, the button in the project's top
// line, one change in its states, and the diff block. The view itself is
// these rows in a sheet, from the right on a desktop and from the bottom on
// a phone, as the comments are.

const noop = () => {}
const MINUTE = 60_000

const BEFORE = "# Plan\n\nShip the comments panel first.\n\n## Steps\n\nThen the markers.\n"
const LEGEND = "Lines marked − were in version 12, and lines marked + are in version 14."
const AFTER = "# Plan\n\nShip the comments panel first, by Friday.\n\n## Steps\n\n1. The markers, on Monday.\n2. The sheet on phones.\n"

/** A change whose diff loads when Show changes opens it. */
function TextChangeSample() {
  const [expanded, setExpanded] = useState(false)
  const [reverted, setReverted] = useState(false)
  return (
    <AgentChangeRow
      agent="Claude"
      person="Ada Lovelace"
      path="notes/plan.md"
      kind="note"
      action="changed"
      version={14}
      when={new Date(NOW.getTime() - 5 * MINUTE)}
      now={NOW}
      isNew
      thread={{ opening: "Add dates to the steps", onShow: noop }}
      expanded={expanded}
      onExpandedChange={setExpanded}
      onOpen={noop}
      onRevert={() => setReverted(true)}
      revertBlocked={reverted ? "Reverted" : null}
      status={reverted ? "Reverted: version 12's text is saved as a new version." : undefined}
    >
      {expanded && (
        <DiffBlock before={BEFORE} after={AFTER} language="markdown" beforeLabel="Version 12" afterLabel="Version 14" legend={LEGEND} className="h-64" />
      )}
    </AgentChangeRow>
  )
}

function DrawingChangeSample() {
  const [expanded, setExpanded] = useState(true)
  return (
    <AgentChangeRow
      agent="Codex"
      person="Ada Lovelace"
      path="flows/sign-up.excalidraw"
      kind="drawing"
      action="changed"
      version={11}
      when={new Date(NOW.getTime() - 3 * 60 * MINUTE)}
      now={NOW}
      expanded={expanded}
      onExpandedChange={setExpanded}
      onOpen={noop}
      onRevert={noop}
      revertBlocked="Changed again since"
    >
      <p className="m-0 text-[13px] text-muted-foreground">Canvas changed. Open the drawing to see it.</p>
    </AgentChangeRow>
  )
}

function DiffBlockSample() {
  const [shown, setShown] = useState(false)
  if (!shown)
    return (
      <Button variant="secondary" className="self-start" onClick={() => setShown(true)}>
        Show a diff
      </Button>
    )
  return <DiffBlock before={BEFORE} after={AFTER} language="markdown" beforeLabel="Version 12" afterLabel="Version 14" legend={LEGEND} className="h-72" />
}

export function AgentChangesSection() {
  return (
    <GuideGroup title="Count, button and change">
      <div className="grid grid-cols-1 gap-7 lg:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-3">
          <GuideLabel>Count badge</GuideLabel>
          <div className="flex items-center gap-3">
            <CountBadge count={1} />
            <CountBadge count={12} />
            <CountBadge count={140} />
          </div>
          <GuideValue>18 high, the accent with a 2px panel ring, 11px mono 600; 99+ past 99. Over a button, which says the count in its name.</GuideValue>
          <GuideLabel>Agent changes button</GuideLabel>
          <div className="flex items-center gap-3">
            <AgentChangesButton count={0} />
            <AgentChangesButton count={3} />
            <AgentChangesButton count={3} size="touch" />
          </div>
          <GuideValue>The bot icon as a ghost icon button, 30 (40 on phones), with the count of changes new to the person.</GuideValue>
          <div className="w-full max-w-[300px]">
            <ProjectHeader
              name="Customer research"
              menu={[{ label: "All projects", onSelect: noop }]}
              actions={<AgentChangesButton count={2} />}
              onShare={noop}
            />
          </div>
          <GuideValue>In the project&apos;s top line, before Share.</GuideValue>
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          <GuideLabel>Change, new, with the thread it answered</GuideLabel>
          <TextChangeSample />
          <GuideValue>
            Radius 12, the panel border, padding 12. The agent named for its person with the bot figure, New in the accent, when in 12 dim; the file with its kind, what happened and the version; the thread the agent&apos;s reply links. Show changes unfolds the diff. Try Revert.
          </GuideValue>
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          <GuideLabel>A drawing, changed again since</GuideLabel>
          <DrawingChangeSample />
          <GuideValue>A drawing says its canvas changed, with Open. Revert is off when the file changed after this version, saying why beside it.</GuideValue>
          <GuideLabel>Diff block</GuideLabel>
          <DiffBlockSample />
          <GuideValue>Monaco&apos;s diff editor, read only, loaded the first time one shows (a loading line until then). Side by side with each side named, or one column with −/+ marks when narrower than 700.</GuideValue>
        </div>
      </div>
    </GuideGroup>
  )
}
