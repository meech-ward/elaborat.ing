import { useId, useState, type KeyboardEvent } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { ButtonShortcut } from "./ButtonShortcut"
import { useCommentsSize, type CommentsSize } from "./commentTypes"
import { COMMENT_MAX_LENGTH, commentLength } from "./commentText"
import { isApplePlatform } from "./shortcuts"

const numbers = new Intl.NumberFormat("en")

/** The send key on this platform: ⌘↵ on Apple platforms, Ctrl+Enter elsewhere. */
function sendShortcut(apple: boolean) {
  return apple ? { label: "⌘↵", aria: "Meta+Enter" } : { label: "Ctrl+Enter", aria: "Control+Enter" }
}

/**
 * Where a comment is written: a new thread, a reply, or an edit. The shadcn
 * Textarea (the field's fill, radius 9, growing with its text), then Cancel
 * and the send button with its key, ⌘↵ or Ctrl+Enter, which also sends from
 * the field; Escape cancels. The count shows from 90% of the limit (5,000)
 * and turns to the danger colour past it, when sending is refused.
 *
 * `onSubmit` gets the trimmed text. While the promise it returns is pending
 * the button is disabled; when it resolves the field empties; when it
 * rejects, the text stays and the error's message shows under the field, so
 * nothing typed is lost. `disabledReason` turns the composer off and says
 * why, such as "Comments need a connection."
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
  maxLength = COMMENT_MAX_LENGTH,
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
  autoFocus?: boolean
  maxLength?: number
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
  const shortcut = sendShortcut(isApplePlatform())
  const disabled = Boolean(disabledReason)
  const touch = size === "touch"

  const submit = async () => {
    if (disabled || pending || !length.sendable) return
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
        disabled={disabled}
        // A composer opens because the person asked to write, so it takes focus.
        autoFocus={autoFocus}
        aria-invalid={length.over || undefined}
        aria-describedby={describedBy}
        className={cn("max-h-60 resize-none", touch ? "min-h-20 px-3 py-2.5 md:text-[15px]" : "min-h-16")}
      />
      {error && (
        <p id={errorId} role="alert" className={cn("leading-snug text-destructive", touch ? "text-[13px]" : "text-xs")}>
          {error}
        </p>
      )}
      {disabled ? (
        <p id={reasonId} className={cn("leading-snug text-muted-foreground", touch ? "text-[13px]" : "text-xs")}>
          {disabledReason}
        </p>
      ) : (
        <div className="flex items-center gap-2">
          {length.show && (
            <span id={countId} className={cn("font-mono text-[11px] tabular-nums", length.over ? "text-destructive" : "text-dim")}>
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
              disabled={pending || !length.sendable}
              onClick={() => void submit()}
              className="gap-2"
            >
              {pending ? "Sending…" : submitLabel}
              {!touch && <ButtonShortcut className="pointer-coarse:hidden">{shortcut.label}</ButtonShortcut>}
            </Button>
          </span>
        </div>
      )}
    </div>
  )
}
