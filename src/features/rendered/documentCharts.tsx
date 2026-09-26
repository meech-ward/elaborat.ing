/*!
 * Chart helpers adapted from shadcn/ui's Base UI chart registry, inspected
 * 2026-09-08: https://github.com/shadcn-ui/ui/blob/main/apps/v4/registry/bases/base/ui/chart.tsx
 * Recharts primitives remain their original components, not custom wrappers.
 *
 * MIT License
 * Copyright (c) 2023 shadcn
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import {
  createContext,
  useContext,
  useId,
  type ComponentProps,
  type ComponentType,
  type CSSProperties,
  type ReactNode,
} from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Label,
  LabelList,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  RadialBar,
  RadialBarChart,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
  type DefaultLegendContentProps,
  type DefaultTooltipContentProps,
  type TooltipValueType,
} from 'recharts';
import { cn } from '../../lib/utils';

export type ChartConfig = Record<string, {
  label?: ReactNode;
  icon?: ComponentType;
} & (
  | { color?: string; theme?: never }
  | { color?: never; theme: { light: string; dark: string } }
)>;

const ChartContext = createContext<ChartConfig | null>(null);

function useChart() {
  const config = useContext(ChartContext);
  if (!config) throw new Error('Chart content must be used within a <ChartContainer>.');
  return config;
}

/** CSSOM values stay on this chart; config never becomes an interpolated rule. */
function chartColors(config: ChartConfig): CSSProperties {
  return Object.fromEntries(Object.entries(config).flatMap(([key, item]) => {
    const color = item.theme
      ? `light-dark(${item.theme.light}, ${item.theme.dark})`
      : item.color;
    return color ? [[`--color-${key}`, color]] : [];
  }));
}

type ChartContainerProps = Omit<ComponentProps<'div'>, 'children'> & {
  config: ChartConfig;
  children: ComponentProps<typeof ResponsiveContainer>['children'];
  initialDimension?: { width: number; height: number };
  description?: ReactNode;
};

export function ChartContainer({
  id,
  className,
  children,
  config,
  style,
  description,
  initialDimension = { width: 320, height: 280 },
  'aria-describedby': describedBy,
  ...props
}: ChartContainerProps) {
  const uniqueId = useId();
  const chartId = id ?? `chart-${uniqueId}`;
  const descriptionId = `${chartId}-description`;
  return (
    <ChartContext.Provider value={config}>
      <div
        role="group"
        {...props}
        id={chartId}
        data-component="ChartContainer"
        data-chart={chartId}
        className={cn('not-prose document-chart', className)}
        style={{ ...chartColors(config), ...style }}
        aria-describedby={[describedBy, description ? descriptionId : undefined].filter(Boolean).join(' ') || undefined}
      >
        {description ? <span id={descriptionId} className="document-chart-description">{description}</span> : null}
        <ResponsiveContainer initialDimension={initialDimension} minWidth={0}>
          {children}
        </ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  );
}

export const ChartTooltip = Tooltip;
export const ChartLegend = Legend;

type ChartTooltipContentProps = Omit<ComponentProps<'div'>, 'color'> &
  DefaultTooltipContentProps<TooltipValueType, number | string> & {
    active?: boolean;
    color?: string;
    hideLabel?: boolean;
    hideIndicator?: boolean;
    indicator?: 'line' | 'dot' | 'dashed';
    nameKey?: string;
    labelKey?: string;
  };

export function ChartTooltipContent({
  active,
  payload,
  className,
  indicator = 'dot',
  hideLabel = false,
  hideIndicator = false,
  label,
  labelFormatter,
  labelClassName,
  formatter,
  color,
  nameKey,
  labelKey,
  accessibilityLayer,
}: ChartTooltipContentProps) {
  const config = useChart();
  if (!active || !payload?.length) return null;

  const first = payload[0];
  const labelConfig = getPayloadConfig(config, first, `${labelKey ?? first.dataKey ?? first.name ?? 'value'}`);
  const labelValue = !labelKey && typeof label === 'string'
    ? ownConfig(config, label)?.label ?? label
    : labelConfig?.label;
  const tooltipLabel = hideLabel ? null : labelFormatter
    ? <div className={cn('document-chart-tooltip-label', labelClassName)}>{labelFormatter(labelValue, payload)}</div>
    : labelValue != null
      ? <div className={cn('document-chart-tooltip-label', labelClassName)}>{labelValue}</div>
      : null;
  const nestLabel = payload.length === 1 && indicator !== 'dot';

  return (
    <div
      className={cn('not-prose document-chart-tooltip', className)}
      role={accessibilityLayer ? 'status' : undefined}
      aria-live={accessibilityLayer ? 'polite' : undefined}
    >
      {!nestLabel ? tooltipLabel : null}
      {payload.filter(item => item.type !== 'none').map((item, index) => {
        const itemConfig = getPayloadConfig(config, item, `${nameKey ?? item.name ?? item.dataKey ?? 'value'}`);
        const indicatorColor = color ?? item.payload?.fill ?? item.color;
        const Icon = itemConfig?.icon;
        return (
          <div className="document-chart-tooltip-row" key={`${item.dataKey ?? item.name}-${index}`}>
            {formatter && item.value !== undefined && item.name != null ? (
              formatter(item.value, item.name, item, index, payload)
            ) : (
              <>
                {Icon ? <Icon /> : !hideIndicator ? (
                  <span
                    aria-hidden="true"
                    className="document-chart-indicator"
                    data-indicator={indicator}
                    style={{ '--indicator-color': indicatorColor } as CSSProperties}
                  />
                ) : null}
                <div className="document-chart-tooltip-name">
                  {nestLabel ? tooltipLabel : null}
                  <span>{itemConfig?.label ?? item.name}</span>
                </div>
                {item.value != null ? (
                  <span className="document-chart-tooltip-value">
                    {typeof item.value === 'number' ? item.value.toLocaleString() : String(item.value)}
                  </span>
                ) : null}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

type ChartLegendContentProps = Pick<DefaultLegendContentProps, 'payload' | 'verticalAlign'> & {
  className?: string;
  hideIcon?: boolean;
  nameKey?: string;
};

export function ChartLegendContent({
  className,
  hideIcon = false,
  payload,
  verticalAlign = 'bottom',
  nameKey,
}: ChartLegendContentProps) {
  const config = useChart();
  if (!payload?.length) return null;
  return (
    <div className={cn('not-prose document-chart-legend', className)} data-align={verticalAlign}>
      {payload.filter(item => item.type !== 'none').map((item, index) => {
        const itemConfig = getPayloadConfig(config, item, `${nameKey ?? item.dataKey ?? 'value'}`);
        const Icon = itemConfig?.icon;
        return (
          <div className="document-chart-legend-item" key={`${item.dataKey ?? item.value}-${index}`}>
            {Icon && !hideIcon ? <Icon /> : (
              <span aria-hidden="true" className="document-chart-indicator" style={{ '--indicator-color': item.color } as CSSProperties} />
            )}
            <span>{itemConfig?.label ?? item.value}</span>
          </div>
        );
      })}
    </div>
  );
}

function ownConfig(config: ChartConfig, key: string) {
  return Object.hasOwn(config, key) ? config[key] : undefined;
}

/** Recharts data stays arbitrary; only the config label lookup is inspected. */
function getPayloadConfig(config: ChartConfig, payload: unknown, key: string) {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const nested = 'payload' in payload && typeof payload.payload === 'object' && payload.payload !== null
    ? payload.payload
    : undefined;
  const directValue = key in payload ? payload[key as keyof typeof payload] : undefined;
  const nestedValue = nested && key in nested ? nested[key as keyof typeof nested] : undefined;
  const configKey = typeof directValue === 'string' ? directValue : typeof nestedValue === 'string' ? nestedValue : key;
  return ownConfig(config, configKey) ?? ownConfig(config, key);
}

/** Finite app-owned runtime names, shared by Fluid and the legacy preview. */
export const DOCUMENT_CHART_COMPONENTS = {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Label,
  LabelList,
  Line,
  LineChart,
  Pie,
  PieChart,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  RadialBar,
  RadialBarChart,
  ReferenceLine,
  Scatter,
  ScatterChart,
  XAxis,
  YAxis,
  ZAxis,
};
