/**
 * The app's built-in components as the component preview's frame provides
 * them to a note: the same ones the app's preview frame gives
 * (src/preview/preview-entry.tsx), without its editing controls. Code blocks
 * show as plain code, as the rest of the card shows them, which keeps the
 * highlighter's grammars out of the card. Charts are the app's, which the
 * frame loads only for a note with a chart (runtime.tsx); until then, or
 * where they do not load, a chart shows as a box with its description that
 * says charts show in elaborat.ing. Drawing and Diagram come from the frame,
 * which draws them from the server's pictures (runtime.tsx).
 */
import type { ReactNode } from "react"
import { EmbedBox } from "@/features/design-system/ui/EmbedBox"
import { CHART_COMPONENT_CATALOG } from "@/features/document/chartCatalog"
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Callout,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Columns,
  Counter,
  Separator,
} from "@/features/rendered/components"
import { ExampleCard, Important, Instruction, Note, SideBySide, SideBySideBlock, Tab, Tabs, Warning } from "@/features/rendered/documentBlocks"

export const CHART_TEXT = "Charts show in elaborat.ing."

/** A chart in a note: its description, if it has one, and where to see it. Its parts inside are not shown. */
function ChartBox({ name, description, label }: { name: string; description?: unknown; label?: unknown }): ReactNode {
  const words = typeof description === "string" ? description : typeof label === "string" ? label : null
  return (
    <EmbedBox
      data-chart-placeholder={name}
      caption={<code>{`<${name}>`}</code>}
      message={
        <>
          {words && <span className="mb-1 block text-body">{words}</span>}
          {CHART_TEXT}
        </>
      }
      className="not-prose"
    />
  )
}

const CHARTS = Object.fromEntries(
  CHART_COMPONENT_CATALOG.map(({ name }) => [
    name,
    (props: { description?: unknown; "aria-label"?: unknown }) => <ChartBox name={name} description={props.description} label={props["aria-label"]} />,
  ]),
)

export const PREVIEW_COMPONENTS: Record<string, unknown> = {
  ...CHARTS,
  Note,
  Warning,
  Important,
  Instruction,
  SideBySide,
  SideBySideBlock,
  ExampleCard,
  Tabs,
  Tab,
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Columns,
  Separator,
  Counter,
  Callout,
}
