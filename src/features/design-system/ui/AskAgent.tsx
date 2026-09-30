import { BotMessageSquare } from "lucide-react"
import { useId } from "react"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import { useCommentsSize, type CommentsSize } from "./commentTypes"

// "Ask an agent" on a comment thread: the person who starts a thread asks
// their own connected agents to deal with it. They turn it on with the
// switch, in the new comment's composer or on their thread; everyone sees
// the badge on the thread.

/** A thread whose author asked their agent to deal with it: shadcn's Badge in accentSoft, the bot icon. */
export function AskAgentBadge({ className }: { className?: string }) {
  return (
    <Badge variant="soft" title="Its author asked their agent to deal with it" className={className}>
      <BotMessageSquare data-icon="inline-start" aria-hidden="true" />
      Ask an agent
    </Badge>
  )
}

/**
 * The switch that asks the author's agents: shadcn's Switch (small) and its
 * label, 12px muted (13 on touch). `disabled` while a change is saving.
 */
export function AskAgentSwitch({
  checked,
  onCheckedChange,
  disabled,
  size: sizeProp,
  className,
}: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  size?: CommentsSize
  className?: string
}) {
  const id = useId()
  const touch = useCommentsSize(sizeProp) === "touch"
  return (
    <span data-slot="ask-agent" className={cn("flex items-center gap-2", touch && "min-h-10", className)}>
      <Switch
        id={id}
        size="sm"
        checked={checked}
        disabled={disabled}
        onCheckedChange={(next) => onCheckedChange(next)}
        title="Your connected agents find this thread when you ask them to work through your comments"
      />
      <Label htmlFor={id} className={cn("font-normal whitespace-nowrap text-muted-foreground", touch ? "text-[13px]" : "text-xs")}>
        Ask an agent
      </Label>
    </span>
  )
}
