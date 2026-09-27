import { useEffect, useState, type ComponentProps } from "react"
import { cn } from "@/lib/utils"

// No primitive scales a laid-out screen: this keeps a fixed-width layout
// (C5's 1440 wide screen, its 1128 wide editor, a desktop tool island) whole
// on a narrower page.

/**
 * Lays its children out `width` wide (or as wide as they are, without it)
 * and shows them at that size where they fit, scaled down to the width
 * there is where they do not, keeping their proportions; the frame takes
 * the scaled height. Nothing is cut off or scrolled sideways, and a phone
 * sees the whole desktop screen, small. The children stay live: they can
 * be pointed at, tapped and focused.
 */
export function ScaleToFit({ width, className, style, children, ...props }: ComponentProps<"div"> & { width?: number }) {
  const [frame, setFrame] = useState<HTMLDivElement | null>(null)
  const [content, setContent] = useState<HTMLDivElement | null>(null)
  const [fit, setFit] = useState({ scale: 0, width: 0, height: 0 })
  useEffect(() => {
    if (!frame || !content) return
    const observer = new ResizeObserver(() => {
      // offsetWidth and offsetHeight are the layout size, before the scale.
      const natural = content.offsetWidth
      const scale = natural ? Math.min(1, frame.clientWidth / natural) : 0
      setFit({ scale, width: natural, height: content.offsetHeight * scale })
    })
    observer.observe(frame)
    observer.observe(content)
    return () => observer.disconnect()
  }, [frame, content])
  return (
    <div
      ref={setFrame}
      data-slot="scale-to-fit"
      className={cn("relative w-full", className)}
      style={{ maxWidth: width ?? (fit.width || undefined), height: fit.height, ...style }}
      {...props}
    >
      <div
        ref={setContent}
        className="absolute top-0 left-0 origin-top-left"
        style={{ width: width ?? "max-content", transform: `scale(${fit.scale})` }}
      >
        {children}
      </div>
    </div>
  )
}
