import { useState, type KeyboardEvent } from "react"
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command"
import { Kbd } from "@/components/ui/kbd"
import { KindBadge } from "./KindBadge"
import { labelParts, quickOpenMatches, type MatchRange } from "./quickOpenMatch"
import type { QuickOpenCommand, QuickOpenMode, QuickOpenProps } from "./QuickOpen"
import { commandShortcut, isApplePlatform } from "./shortcuts"

// The palette's list (QuickOpen.tsx), with cmdk, in a chunk of its own that
// loads the first time the palette opens.

/** The key that opens each list. */
const MODE_KEY = { files: "p", commands: "k" } as const

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
export function QuickOpenList({
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
