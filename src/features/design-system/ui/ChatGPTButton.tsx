import { cva } from "class-variance-authority"
import type { ComponentProps } from "react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { ChatGPTMark } from "./ChatGPTMark"

// OpenAI's four approved sign-in buttons: "Continue with ChatGPT" or "Sign in
// with ChatGPT", black or white, with the ChatGPT mark. Their size is
// OpenAI's: 45 high, radius 12, 20 either side, a 12 gap, 15px medium text,
// the mark at 21. The shadcn Button, restyled to that.

export const chatGptButtonVariants = cva(
  "h-[45px] w-[242px] max-w-full gap-3 rounded-[12px] px-5 text-[15px] leading-[18px] font-medium pointer-coarse:h-[45px]",
  {
    variants: {
      tone: {
        black: "bg-black text-white hover:bg-black active:bg-black",
        white: "border border-black/15 bg-white text-black hover:bg-white active:bg-white",
        // Black on a light page, white on a dark one.
        auto: "bg-black text-white hover:bg-black active:bg-black dark:bg-white dark:text-black dark:hover:bg-white dark:active:bg-white",
      },
    },
    defaultVariants: { tone: "auto" },
  },
)

export type ChatGPTButtonProps = Omit<ComponentProps<typeof Button>, "variant" | "size" | "children"> & {
  /** "Continue with ChatGPT" (continue) or "Sign in with ChatGPT" (sign-in). */
  action?: "continue" | "sign-in"
  /** Black, white, or the one that suits the light or dark theme (auto). */
  tone?: "black" | "white" | "auto"
}

/** Starts Sign in with ChatGPT: one of OpenAI's approved buttons. */
export function ChatGPTButton({ action = "continue", tone = "auto", className, ...props }: ChatGPTButtonProps) {
  return (
    <Button className={cn(chatGptButtonVariants({ tone }), className)} {...props}>
      <ChatGPTMark className="size-[21px]" />
      <span>{action === "continue" ? "Continue with ChatGPT" : "Sign in with ChatGPT"}</span>
    </Button>
  )
}
