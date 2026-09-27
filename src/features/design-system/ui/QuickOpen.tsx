import { useState, type ComponentProps, type KeyboardEvent } from "react"
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { Kbd } from "@/components/ui/kbd"
import { cn } from "@/lib/utils"
import { KindBadge, type FileKind } from "./KindBadge"
import { labelParts, quickOpenMatches } from "./quickOpenMatch"
import { commandShortcut, isApplePlatform } from "./shortcuts"

// Go to file (⌘P, Ctrl+P off Apple platforms): the shadcn command list in the shadcn dialog, as C5
// draws it: 560 wide near the top, padding 8 and radius 12 on the panel
// shadow with no dimming behind; the query in a 38px field with a 2px
// accent border and the ⌘P key; 34px rows with the kind badge, the matched
// characters in bold and the folder dim on the right; key hints below.

/** A file the palette can open. */
export interface QuickOpenFile {
  path: string
  kind: FileKind
}

export interface QuickOpenProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Every file in the project, best first (recent, say); the palette keeps that order within a match rank. */
  files: readonly QuickOpenFile[]
  /** Open the chosen file: Enter opens it, ⌘Enter (Ctrl+Enter) opens it to the side. The palette then closes. */
  onOpen: (path: string, options: { toSide: boolean }) => void
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

export function QuickOpen({ open, onOpenChange, files, onOpen, defaultQuery = "", modal, finalFocus, container, className }: QuickOpenProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => onOpenChange(next)} modal={modal}>
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
        <DialogTitle className="sr-only">Go to file</DialogTitle>
        <DialogDescription className="sr-only">Find a file in this project.</DialogDescription>
        <QuickOpenList
          files={files}
          defaultQuery={defaultQuery}
          onOpen={(path, options) => {
            onOpen(path, options)
            onOpenChange(false)
          }}
        />
      </DialogContent>
    </Dialog>
  )
}

/** The palette's contents: the query field, the matching files and the key hints. */
function QuickOpenList({
  files,
  defaultQuery,
  onOpen,
}: Pick<QuickOpenProps, "files" | "onOpen"> & { defaultQuery: string }) {
  const [query, setQuery] = useState(defaultQuery)
  const [selected, setSelected] = useState("")
  const matches = quickOpenMatches(files, query)
  const apple = isApplePlatform()

  // cmdk opens the selected item on Enter; ⌘Enter (Ctrl+Enter) opens it to the side instead.
  const openToSide = (event: KeyboardEvent) => {
    if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return
    const match = matches.find(({ file }) => file.path === selected)
    if (!match) return
    event.preventDefault()
    onOpen(match.file.path, { toSide: true })
  }

  return (
    // The list is already filtered and ordered, so cmdk does not filter again.
    <Command label="Search files" shouldFilter={false} value={selected} onValueChange={setSelected} onKeyDown={openToSide} className="p-0">
      <div className="mb-1.5 flex h-[38px] shrink-0 items-center gap-2.5 rounded-button border-2 border-primary bg-field px-2.5">
        <Kbd className="h-auto py-0.5">{commandShortcut("p", apple).label}</Kbd>
        <CommandInput autoFocus aria-label="Search files" placeholder="Go to file" value={query} onValueChange={setQuery} className="min-w-0 flex-1 px-0.5" />
      </div>
      <CommandList>
        <CommandEmpty>No matching files.</CommandEmpty>
        {matches.map(({ file, label, folder, ranges }) => (
          <CommandItem key={file.path} value={file.path} onSelect={() => onOpen(file.path, { toSide: false })}>
            <KindBadge kind={file.kind} />
            <span className="min-w-0 flex-1 truncate">
              {labelParts(label, ranges).map((part, index) =>
                part.matched ? <strong key={index}>{part.text}</strong> : <span key={index}>{part.text}</span>,
              )}
            </span>
            {/* The trailing slot: it also hides the item's check mark. */}
            {folder && <CommandShortcut className="font-sans text-xs">{folder}</CommandShortcut>}
          </CommandItem>
        ))}
      </CommandList>
      <div className="flex flex-wrap gap-x-4 gap-y-1 px-3 pt-2 pb-0.5 text-xs text-dim">
        <span>Enter open</span>
        <span>{apple ? "⌘Enter" : "Ctrl+Enter"} open to the side</span>
        <span>{commandShortcut("k", apple).label} commands</span>
      </div>
    </Command>
  )
}
