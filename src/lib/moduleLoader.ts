import { useEffect, useState } from "react"

/**
 * A part of the app that loads in its own chunk the first time it is needed
 * (the code editor, the rendered note, the compare view). It loads once; a
 * failed load (a file missing after a deploy, or no connection before the
 * service worker has cached it) is let go, so the next use tries again.
 */
export type ModuleLoader<T> = {
  load(): Promise<T>
  /** Start loading without waiting, for example when the pointer reaches the button that shows it. */
  preload(): void
  /** The module when it has loaded, or null. */
  loaded(): T | null
}

export function moduleLoader<T extends object>(load: () => Promise<T>): ModuleLoader<T> {
  let loading: Promise<T> | null = null
  let module: T | null = null
  const start = () => {
    loading ??= load().then(
      (value) => {
        module = value
        return value
      },
      (error: unknown) => {
        loading = null
        throw error
      },
    )
    return loading
  }
  return {
    load: start,
    preload: () => {
      start().catch(() => {})
    },
    loaded: () => module,
  }
}

/**
 * The loader's module once `wanted` (at once when it is already loaded), or
 * why it could not load and a way to try again.
 */
export function useModule<T extends object>(loader: ModuleLoader<T>, wanted: boolean): { module: T | null; error: string | null; retry: () => void } {
  const [state, setState] = useState<{ module: T | null; error: string | null; attempt: number }>(() => ({ module: loader.loaded(), error: null, attempt: 0 }))
  const { module, attempt } = state
  useEffect(() => {
    if (!wanted || module) return
    let alive = true
    loader.load().then(
      (loaded) => {
        if (alive) setState((current) => ({ ...current, module: loaded, error: null }))
      },
      (error: unknown) => {
        if (alive) setState((current) => ({ ...current, error: error instanceof Error ? error.message : String(error) }))
      },
    )
    return () => {
      alive = false
    }
  }, [attempt, loader, module, wanted])
  return {
    module,
    error: state.error,
    retry: () => setState((current) => ({ ...current, error: null, attempt: current.attempt + 1 })),
  }
}
