import { useId, useLayoutEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/** How many lines long text shows while folded. */
export const FOLDED_LINES = 12

/**
 * Text that can run long, such as a report pasted into a comment. Past 12
 * lines it shows folded to them, with Show more under it, and Show less once
 * open; shorter text shows whole, with no button. Whether it runs long is
 * measured once it is laid out and again when its width changes, so a narrow
 * panel folds what a wide one shows whole. The whole text stays in the page,
 * so a screen reader reads all of it. Show less brings the button back into
 * view when folding moves it out.
 *
 * `className` styles the text; `toggleClassName` the line with the button,
 * such as its size.
 */
export function FoldedText({ text, className, toggleClassName }: { text: string; className?: string; toggleClassName?: string }) {
  const textRef = useRef<HTMLParagraphElement>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const id = useId()
  const [long, setLong] = useState(false)
  const [open, setOpen] = useState(false)

  useLayoutEffect(() => {
    const element = textRef.current
    if (!element) return
    const measure = () => {
      const style = getComputedStyle(element)
      const line = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.2
      // scrollHeight is the whole text's height, folded or not.
      setLong(element.scrollHeight > line * FOLDED_LINES + 1)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [text])

  const toggle = () => {
    setOpen(!open)
    if (open) requestAnimationFrame(() => toggleRef.current?.scrollIntoView({ block: "nearest" }))
  }

  return (
    <>
      <p id={id} ref={textRef} data-folded={(long && !open) || undefined} className={cn(long && !open && "line-clamp-12", className)}>
        {text}
      </p>
      {long && (
        <p className={cn("mt-1", toggleClassName)}>
          <Button ref={toggleRef} variant="link" size="inline" aria-expanded={open} aria-controls={id} onClick={toggle}>
            {open ? "Show less" : "Show more"}
          </Button>
        </p>
      )}
    </>
  )
}
