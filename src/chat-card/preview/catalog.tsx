/**
 * The app's built-in components as the component preview's frame provides
 * them to a note: the same ones the app's preview frame gives
 * (src/preview/preview-entry.tsx), without its editing controls. Code blocks
 * show as plain code, as the rest of the card shows them, which keeps the
 * highlighter's grammars out of the card. Charts show as a box with the
 * chart's description that says they show in elaborat.ing: their library
 * would add about half a megabyte to the card. Drawing and Diagram come from
 * the frame, which draws them from the server's pictures (runtime.tsx).
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
    <EmbedBox data-chart-placeholder={name} caption={<code>{`<${name}>`}</code>} className="not-prose">
      <div className="text-center text-[13px] leading-snug text-muted-foreground">
        {words && <p className="m-0 mb-1 text-body">{words}</p>}
        <p className="m-0">{CHART_TEXT}</p>
      </div>
    </EmbedBox>
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
