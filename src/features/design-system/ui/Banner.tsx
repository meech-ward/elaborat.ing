import type { ComponentProps, ReactNode } from "react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

// Banners and callouts are the shadcn alert. A banner reports something the
// person may need to act on: warn (warnBg, e.g. a file changed on another
// device), danger (a failure) or info (plain news on the seg fill). A danger
// banner is announced at once (role alert); the others politely (status).
// A callout is standing guidance in accentSoft, not an event (role note).

const BANNER_VARIANT = { warn: "warning", danger: "destructive", info: "default" } as const
export type BannerTone = keyof typeof BANNER_VARIANT

export function Banner({
  tone = "warn",
  action,
  children,
  className,
  ...props
}: Omit<ComponentProps<typeof Alert>, "variant"> & {
  tone?: BannerTone
  /** A button that follows the message, such as <BannerAction>Compare</BannerAction>. */
  action?: ReactNode
}) {
  return (
    <Alert
      role={tone === "danger" ? "alert" : "status"}
      variant={BANNER_VARIANT[tone]}
      data-tone={tone}
      className={className}
      {...props}
    >
      <AlertDescription>
        {children}
        {action && <> {action}</>}
      </AlertDescription>
    </Alert>
  )
}

/** The banner's action: a text button in the banner's own colour and weight, underlined. */
export function BannerAction({ className, ...props }: ComponentProps<typeof Button>) {
  return (
    <Button
      variant="link"
      className={cn(
        "inline h-auto p-0 align-baseline text-[length:inherit] font-[inherit] text-current underline decoration-1 underline-offset-2 hover:decoration-2",
        className,
      )}
      {...props}
    />
  )
}

/** Standing guidance in the accentSoft colours: 14px at 1.5, padding 12 by 14. */
export function Callout({ className, children, ...props }: Omit<ComponentProps<typeof Alert>, "variant">) {
  return (
    <Alert role="note" variant="soft" className={cn("px-3.5 py-3 text-sm leading-normal", className)} {...props}>
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  )
}
