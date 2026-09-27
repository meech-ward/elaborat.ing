import { useState, type ComponentProps, type KeyboardEvent } from "react"
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { Kbd } from "@/components/ui/kbd"
import { cn } from "@/lib/utils"
import { KindBadge, type FileKind } from "./KindBadge"
import { labelParts, quickOpenMatches, type MatchRange } from "./quickOpenMatch"
import { commandShortcut, isApplePlatform, type Shortcut } from "./shortcuts"

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

/** The key that opens each list. */
const MODE_KEY = { files: "p", commands: "k" } as const

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
        <QuickOpenList
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

/** The matched characters in bold. */
function Emphasis({ label, ranges }: { label: string; ranges: readonly MatchRange[] }) {
  return (
    <span className="min-w-0 flex-1 truncate">
      {labelParts(label, ranges).map((part, index) =>
        part.matched ? <strong key={index}>{part.text}</strong> : <span key={index}>{part.text}</span>,
      )}
    </span>
  )
}

/** The palette's contents: the query field, the matching files or commands and the key hints. */
function QuickOpenList({
  mode,
  files,
  commands = [],
  defaultQuery,
  onOpen,
  onRun,
  onKey,
}: Pick<QuickOpenProps, "files" | "commands" | "onOpen"> & {
  mode: QuickOpenMode
  defaultQuery: string
  onRun: (command: QuickOpenCommand) => void
  /** ⌘K or ⌘P, pressed in the palette. */
  onKey: (key: "k" | "p") => void
}) {
  const [query, setQuery] = useState(defaultQuery)
  const apple = isApplePlatform()
  const name = mode === "files" ? "Search files" : "Search commands"
  const hints =
    mode === "files"
      ? ["Enter open", ...(commands.length ? [`${commandShortcut("k", apple).label} commands`] : [])]
      : ["Enter run", `${commandShortcut("p", apple).label} files`]

  const switchKey = (event: KeyboardEvent) => {
    const key = event.key.toLowerCase()
    if ((key !== "k" && key !== "p") || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
    event.preventDefault()
    onKey(key)
  }

  return (
    // The lists are already filtered and ordered, so cmdk does not filter again.
    <Command label={name} shouldFilter={false} onKeyDown={switchKey} className="p-0">
      <div className="mb-1.5 flex h-[38px] shrink-0 items-center gap-2.5 rounded-button border-2 border-primary bg-field px-2.5">
        <Kbd className="h-auto py-0.5">{commandShortcut(MODE_KEY[mode], apple).label}</Kbd>
        <CommandInput
          autoFocus
          aria-label={name}
          placeholder={mode === "files" ? "Go to file" : "Run a command"}
          value={query}
          onValueChange={setQuery}
          className="min-w-0 flex-1 px-0.5"
        />
      </div>
      <CommandList className="max-h-[min(340px,60dvh)]">
        <CommandEmpty>{mode === "files" ? "No matching files." : "No matching commands."}</CommandEmpty>
        {mode === "files"
          ? quickOpenMatches(files, query).map(({ file, label, folder, ranges }) => (
              <CommandItem key={file.path} value={file.path} onSelect={() => onOpen(file.path)}>
                <KindBadge kind={file.kind} />
                <Emphasis label={label} ranges={ranges} />
                {/* The trailing slot: it also hides the item's check mark. */}
                {folder && <CommandShortcut className="font-sans text-xs">{folder}</CommandShortcut>}
              </CommandItem>
            ))
          : quickOpenMatches(
              commands.map((command) => ({ path: command.label, command })),
              query,
            ).map(({ file: { command }, label, ranges }) => (
              <CommandItem
                key={command.label}
                value={command.label}
                aria-keyshortcuts={command.shortcut?.aria}
                onSelect={() => onRun(command)}
              >
                <Emphasis label={label} ranges={ranges} />
                {command.shortcut && <CommandShortcut aria-hidden="true">{command.shortcut.label}</CommandShortcut>}
              </CommandItem>
            ))}
      </CommandList>
      <div className="flex flex-wrap gap-x-4 gap-y-1 px-3 pt-2 pb-0.5 text-xs text-dim pointer-coarse:hidden">
        {hints.map((hint) => (
          <span key={hint}>{hint}</span>
        ))}
      </div>
    </Command>
  )
}
