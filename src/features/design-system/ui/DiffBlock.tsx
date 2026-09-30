import { moduleLoader, useModule } from "@/lib/moduleLoader"
import { Banner, BannerAction } from "./Banner"
import { LoadingLine } from "./LoadingLine"

export type DiffBlockProps = {
  before: string
  after: string
  /** A Monaco language id: markdown, mdx, d2, json or plaintext. */
  language: string
  /** What each side is, over it and as its editor's name: "On the server", "Version 4". */
  beforeLabel: string
  afterLabel: string
  /** What the −/+ marks mean when both show in one column; by default it names the two sides. */
  legend?: string
  /** Classes for the diff's box, such as another height. */
  className?: string
}

// Monaco's diff editor loads the first time a diff shows (TextDiff.tsx).
const textDiff = moduleLoader(() => import("./TextDiff"))

/**
 * Two versions of a text file, what changed marked line by line (Monaco's
 * diff editor, read-only): side by side with each side named, or in one
 * column with −/+ marks where there is no room for two. The editor is a
 * dynamic import: a loading line shows while it loads, and Try again if it
 * fails.
 */
export function DiffBlock(props: DiffBlockProps) {
  const { module, error, retry } = useModule(textDiff, true)
  if (module) {
    const { TextDiff } = module
    return <TextDiff {...props} />
  }
  if (error)
    return (
      <Banner tone="danger" action={<BannerAction onClick={retry}>Try again</BannerAction>}>
        The comparison could not load.
      </Banner>
    )
  return <LoadingLine label="Loading the comparison" />
}
