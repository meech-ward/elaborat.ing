import { CircleAlert } from "lucide-react"
import { useId, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { ButtonShortcut } from "./ButtonShortcut"
import { useCommentsSize, type CommentsSize } from "./commentTypes"
import { COMMENT_MAX_LENGTH, commentLength } from "./commentText"
import { isApplePlatform } from "./shortcuts"

const numbers = new Intl.NumberFormat("en")

/** The send key on this platform: ⌘↵ on Apple platforms, Ctrl ↵ elsewhere. */
function sendShortcut(apple: boolean) {
  return apple ? { label: "⌘↵", aria: "Meta+Enter" } : { label: "Ctrl ↵", aria: "Control+Enter" }
}

/**
 * Where a comment is written: a new thread, a reply, or an edit. The shadcn
 * Textarea (the field's fill, radius 9, growing with its text), then Cancel
 * and the send button with its key, ⌘↵ or Ctrl ↵, which also sends from
 * the field; Escape cancels. The count shows from 90% of the limit (100,000)
 * and turns to the danger colour, with the alert icon, past it, when
 * sending is refused; while it shows, the button drops its key chip.
 *
 * `onSubmit` gets the trimmed text. While the promise it returns is pending
 * the button is disabled; when it resolves the field empties; when it
 * rejects, the text stays and the error's message shows under the field, so
 * nothing typed is lost. `disabledReason` turns the composer off and says
 * why, such as "Comments need a connection." `start` goes at the start of
 * the button row, such as the Ask an agent switch.
 */
export function CommentComposer({
  label = "Comment",
  placeholder = "Add a comment",
  submitLabel = "Comment",
  value: controlled,
  onValueChange,
  defaultValue = "",
  onSubmit,
  onCancel,
  disabledReason,
  error: shownError,
  autoFocus,
  requireChange = false,
  maxLength = COMMENT_MAX_LENGTH,
  start,
  size: sizeProp,
  className,
}: {
  /** The field's accessible name: "Comment", "Reply", "Edit comment". */
  label?: string
  placeholder?: string
  /** The send button's word: Comment, Reply or Save. */
  submitLabel?: string
  /** The text, when the caller keeps it (a draft that outlives the panel). */
  value?: string
  onValueChange?: (value: string) => void
  defaultValue?: string
  onSubmit: (body: string) => void | Promise<unknown>
  /** Shows Cancel, and Escape in the field calls it. */
  onCancel?: () => void
  disabledReason?: string | null
  /** A problem to show under the field from outside, such as the store's last error. */
  error?: string | null
  /** Takes focus when it appears, with the caret after the text. */
  autoFocus?: boolean
  /** Sending needs text other than `defaultValue` (an edit that changed nothing can't be saved). */
  requireChange?: boolean
  maxLength?: number
  /** Before the count and the buttons, such as the Ask an agent switch. */
  start?: ReactNode
  size?: CommentsSize
  className?: string
}) {
  const size = useCommentsSize(sizeProp)
  const [own, setOwn] = useState(defaultValue)
  const value = controlled ?? own
  const setValue = (next: string) => {
    if (controlled === undefined) setOwn(next)
    onValueChange?.(next)
  }
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const error = failed ?? shownError
  const countId = useId()
  const errorId = useId()
  const reasonId = useId()
  const length = commentLength(value, maxLength)
  const sendable = length.sendable && !(requireChange && value.trim() === defaultValue.trim())
  const shortcut = sendShortcut(isApplePlatform())
  // The first focus of a composer that opens focused puts the caret after
  // any text it starts with (an edit), not before it.
  const placed = useRef(false)
  const onFocus = (event: FocusEvent<HTMLTextAreaElement>) => {
    if (!autoFocus || placed.current) return
    placed.current = true
    const end = event.currentTarget.value.length
    event.currentTarget.setSelectionRange(end, end)
  }
  const disabled = Boolean(disabledReason)
  const touch = size === "touch"

  const submit = async () => {
    if (disabled || pending || !sendable) return
    setPending(true)
    setFailed(null)
    try {
      await onSubmit(value.trim())
      setValue("")
    } catch (failure) {
      setFailed(failure instanceof Error && failure.message ? failure.message : "Could not send. Try again.")
    } finally {
      setPending(false)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      void submit()
    } else if (event.key === "Escape" && onCancel) {
      event.preventDefault()
      event.stopPropagation()
      onCancel()
    }
  }

  const describedBy = [length.show && countId, error && errorId, disabled && reasonId].filter(Boolean).join(" ") || undefined

  return (
    <div data-slot="comment-composer" className={cn("flex flex-col gap-2", className)}>
      <Textarea
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        readOnly={pending}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        disabled={disabled}
        // A composer opens because the person asked to write, so it takes focus.
        autoFocus={autoFocus}
        aria-invalid={length.over || undefined}
        aria-describedby={describedBy}
        className={cn("max-h-60 resize-none", touch ? "min-h-20 px-3 py-2.5 md:text-[15px]" : "min-h-16")}
      />
      {error && (
        <p id={errorId} role="alert" className={cn("flex items-start gap-1.5 leading-snug text-destructive", touch ? "text-[13px]" : "text-xs")}>
          <CircleAlert aria-hidden="true" className="mt-px size-3.5 shrink-0" />
          <span className="min-w-0">{error}</span>
        </p>
      )}
      {disabled ? (
        <p id={reasonId} className={cn("leading-snug text-muted-foreground", touch ? "text-[13px]" : "text-xs")}>
          {disabledReason}
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {start}
          {length.show && (
            <span
              id={countId}
              className={cn("flex items-center gap-1 font-mono text-[11px] whitespace-nowrap tabular-nums", length.over ? "text-destructive" : "text-dim")}
            >
              {length.over && <CircleAlert aria-hidden="true" className="size-3 shrink-0" />}
              {numbers.format(length.count)} / {numbers.format(maxLength)}
              <span className="sr-only">{length.over ? " characters, too long" : " characters"}</span>
            </span>
          )}
          <span className="ml-auto flex items-center gap-1.5">
            {onCancel && (
              <Button type="button" variant="ghost" size={touch ? "touch" : "sm"} onClick={onCancel}>
                Cancel
              </Button>
            )}
            <Button
              type="button"
              size={touch ? "touch" : "sm"}
              aria-keyshortcuts={shortcut.aria}
              disabled={pending || !sendable}
              onClick={() => void submit()}
              className="gap-2"
            >
              {pending ? "Sending…" : submitLabel}
              {!touch && !length.show && <ButtonShortcut className="pointer-coarse:hidden">{shortcut.label}</ButtonShortcut>}
            </Button>
          </span>
        </div>
      )}
    </div>
  )
}
