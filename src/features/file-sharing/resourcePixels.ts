import { prepareVisibleAssets } from '@/features/workbench/progressiveAssets'

export type ResourceTarget = {path: string; identity: string}
export type ResourceSnapshot = {
  pixels: Record<string, string>
  identities: Record<string, string>
  errors: string[]
}
type Entry = {identity: string; promise: Promise<string>; pixel?: string; failed?: boolean}

/** Exact source identities keep independent ready resources across arrivals. */
export class SharedResourcePixels {
  private readonly entries = new Map<string, Entry>()

  snapshot(targets: readonly ResourceTarget[]): ResourceSnapshot {
    const pixels: Record<string, string> = Object.create(null)
    const identities: Record<string, string> = Object.create(null)
    const errors: string[] = []
    for (const target of targets) {
      const entry = this.entries.get(target.path)
      if (!entry || entry.identity !== target.identity) continue
      identities[target.path] = target.identity
      if (entry.pixel !== undefined) pixels[target.path] = entry.pixel
      if (entry.failed) errors.push(target.path)
    }
    return {pixels, identities, errors}
  }

  async prepare(
    targets: readonly ResourceTarget[], signal: AbortSignal,
    render: (target: ResourceTarget) => Promise<string>,
    publish: (snapshot: ResourceSnapshot) => void,
  ): Promise<void> {
    const wanted = new Map(targets.map(target => [target.path, target.identity]))
    for (const [path, entry] of this.entries) if (wanted.get(path) !== entry.identity) this.entries.delete(path)
    const show = () => {if (!signal.aborted) publish(this.snapshot(targets))}
    show()
    await prepareVisibleAssets(targets, signal, async target => {
      let entry = this.entries.get(target.path)
      if (!entry || entry.identity !== target.identity) {
        entry = {identity: target.identity, promise: render(target)}
        this.entries.set(target.path, entry)
        const own = entry
        void own.promise.then(pixel => {
          if (this.entries.get(target.path) === own) own.pixel = pixel
        }, () => {
          if (this.entries.get(target.path) === own) own.failed = true
        })
      }
      try {await entry.promise} catch { /* only this resource fails */ }
      show()
    })
    show()
  }
}
