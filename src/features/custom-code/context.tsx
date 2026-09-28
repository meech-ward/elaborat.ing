import { createContext, useContext, type ReactNode } from "react"

/**
 * How a project shared with the person treats notes that run custom
 * components. ProjectPage provides it when the person does not own the
 * project; their own projects and the local project have none, and never ask.
 */
export type CustomCodePolicy = {
  /** Where this device keeps the choices: the person and the project. */
  key: string
  /** Who last changed each file, by path ("you" for the person), where the server knows; rejects offline. */
  editors: (paths: readonly string[]) => Promise<ReadonlyMap<string, string>>
}

const CustomCodeContext = createContext<CustomCodePolicy | null>(null)

export function CustomCodeProvider({ value, children }: { value: CustomCodePolicy | null; children: ReactNode }) {
  return <CustomCodeContext value={value}>{children}</CustomCodeContext>
}

/** The open project's policy, or null where custom components run without asking. */
export function useCustomCodePolicy(): CustomCodePolicy | null {
  return useContext(CustomCodeContext)
}
