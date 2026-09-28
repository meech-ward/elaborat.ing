import type { ComponentType, ReactNode } from "react"
import { CHART_COMPONENT_CATALOG } from "../features/document/chartCatalog"
import { useModule } from "../lib/moduleLoader"
import { frameModules } from "./frameModules"

type ChartProps = Record<string, unknown>

/**
 * One of the chart components (ChartContainer, BarChart, Bar, ...). The
 * charts module (Recharts) loads the first time a note shows one. Until it
 * has, a chart keeps its place with an empty box its size; the parts inside
 * a chart only render with it.
 */
function LazyChart({ name, props }: { name: string; props: ChartProps }): ReactNode {
  const { module, error, retry } = useModule(frameModules.charts, true)
  const Chart = module?.DOCUMENT_CHART_COMPONENTS[name as keyof typeof module.DOCUMENT_CHART_COMPONENTS] as ComponentType<ChartProps> | undefined
  if (Chart) return <Chart {...props} />
  if (name !== "ChartContainer" && !name.endsWith("Chart")) return null
  return (
    <div
      className="not-prose document-chart"
      data-chart-pending=""
      role="group"
      aria-label={typeof props["aria-label"] === "string" ? props["aria-label"] : undefined}
      aria-busy={error ? undefined : true}
    >
      {error ? (
        <p>
          The chart could not load.{" "}
          <button type="button" onClick={retry}>
            Try again
          </button>
        </p>
      ) : null}
    </div>
  )
}

/**
 * The chart components as the frame gives them to a note. Each keeps its
 * name: Recharts finds a chart's `Cell`s by it.
 */
export const LAZY_CHART_COMPONENTS: Record<string, ComponentType<ChartProps>> = Object.fromEntries(
  CHART_COMPONENT_CATALOG.map(({ name }) => [name, Object.assign((props: ChartProps) => <LazyChart name={name} props={props} />, { displayName: name })]),
)
