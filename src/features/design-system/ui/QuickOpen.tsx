import type { ComponentProps } from "react"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { moduleLoader, useModule } from "@/lib/moduleLoader"
import { cn } from "@/lib/utils"
import { Banner, BannerAction } from "./Banner"
import type { FileKind } from "./KindBadge"
import { LoadingLine } from "./LoadingLine"
import type { QuickOpenList as QuickOpenListComponent } from "./QuickOpenList"
import type { Shortcut } from "./shortcuts"

// Go to file (⌘P) and Commands (⌘K, Ctrl off Apple platforms): the shadcn
// command list in the shadcn dialog, as C5 draws it: 560 wide near the top,
// padding 8 and radius 12 on the panel shadow with no dimming behind; the
// query in a 38px field with a 2px accent border and the palette's key;
// 34px rows (a file's kind badge, or a command's shortcut on the right)
// with the matched characters in bold; key hints below. ⌘K and ⌘P switch
// between the two, and close the palette when it already shows theirs.

/** A file the palette can open. */
export interface QuickOpenFile {
  path: string
  kind: FileKind
}

/** A command the palette can run. */
export interface QuickOpenCommand {
  /** What the row says; also its key, so labels are unique. */
  label: string
  /** The command's own shortcut, shown at the row's right end. */
  shortcut?: Shortcut
  run: () => void
}

/** Which list the palette shows: files to open, or commands to run. */
export type QuickOpenMode = "files" | "commands"

export interface QuickOpenProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Runs once the palette has finished opening or closing, such as to move focus somewhere a chosen command asked for. */
  onOpenChangeComplete?: ComponentProps<typeof Dialog>["onOpenChangeComplete"]
  /** Every file in the project, best first; the palette keeps that order within a match rank. */
  files: readonly QuickOpenFile[]
  /** Open the chosen file. The palette then closes. */
  onOpen: (path: string) => void
  /** The commands ⌘K lists. Without them the palette only finds files. */
  commands?: readonly QuickOpenCommand[]
  /** "files" (Go to file, the default) or "commands". */
  mode?: QuickOpenMode
  /** ⌘K or ⌘P asked for the other list. */
  onModeChange?: (mode: QuickOpenMode) => void
  /** The query the palette opens with. */
  defaultQuery?: string
  /** Pass false to leave the rest of the page usable (the style guide's held-open sample). */
  modal?: ComponentProps<typeof Dialog>["modal"]
  /**
   * Where focus goes when the palette closes, such as the element that opened
   * it: the palette usually opens from a shortcut, so it has no trigger for
   * focus to return to by default.
   */
  finalFocus?: ComponentProps<typeof DialogContent>["finalFocus"]
  /** Where the dialog renders (the body by default) and extra classes for it. */
  container?: ComponentProps<typeof DialogContent>["container"]
  className?: string
}

// The list, with cmdk, loads the first time the palette opens, so it stays
// out of the project page's first paint; the dialog opens at once.
const quickOpenList = moduleLoader(() => import("./QuickOpenList"))

export function QuickOpen({
  open,
  onOpenChange,
  onOpenChangeComplete,
  files,
  onOpen,
  commands,
  mode = "files",
  onModeChange,
  defaultQuery = "",
  modal,
  finalFocus,
  container,
  className,
}: QuickOpenProps) {
  const listsCommands = mode === "commands" && commands !== undefined
  return (
    <Dialog open={open} onOpenChange={(next) => onOpenChange(next)} onOpenChangeComplete={onOpenChangeComplete} modal={modal}>
      <DialogContent
        container={container}
        finalFocus={finalFocus}
        showOverlay={false}
        showCloseButton={false}
        className={cn(
          "top-[110px] translate-y-0 gap-0 p-2 shadow-panel max-sm:top-4 sm:max-w-[560px] data-open:zoom-in-100 data-closed:zoom-out-100",
          className,
        )}
      >
        <DialogTitle className="sr-only">{listsCommands ? "Commands" : "Go to file"}</DialogTitle>
        <DialogDescription className="sr-only">{listsCommands ? "Run a command." : "Find a file in this project."}</DialogDescription>
        <LazyQuickOpenList
          // A new list, and an empty query, when ⌘K and ⌘P switch between them.
          key={listsCommands ? "commands" : "files"}
          mode={listsCommands ? "commands" : "files"}
          files={files}
          commands={commands}
          defaultQuery={defaultQuery}
          onOpen={(path) => {
            onOpen(path)
            onOpenChange(false)
          }}
          onRun={(command) => {
            command.run()
            onOpenChange(false)
          }}
          onKey={(key) => {
            const next = key === "k" ? "commands" : "files"
            if (next === (listsCommands ? "commands" : "files")) onOpenChange(false)
            else if (onModeChange && (next === "files" || commands)) onModeChange(next)
          }}
        />
      </DialogContent>
    </Dialog>
  )
}

/** The list once its chunk has loaded: the query field's frame and a loading line until then, and Try again when it fails. */
function LazyQuickOpenList(props: ComponentProps<typeof QuickOpenListComponent>) {
  const { module, error, retry } = useModule(quickOpenList, true)
  if (module) {
    const { QuickOpenList } = module
    return <QuickOpenList {...props} />
  }
  if (error) {
    return (
      <Banner tone="danger" action={<BannerAction onClick={retry}>Try again</BannerAction>}>
        The list could not load.
      </Banner>
    )
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div aria-hidden="true" className="h-[38px] rounded-button border-2 border-primary bg-field" />
      <LoadingLine label={props.mode === "files" ? "Loading Go to file" : "Loading commands"} />
    </div>
  )
}
