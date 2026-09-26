import { describe, expect, test } from 'bun:test';
import { compile, run } from '@mdx-js/mdx';
import { renderToStaticMarkup } from 'react-dom/server';
import * as jsxRuntime from 'react/jsx-runtime';
import type { ReactNode } from 'react';
import type { TooltipPayloadEntry } from 'recharts';
import { CHART_COMPONENT_CATALOG } from '../document/chartCatalog';
import {
  ChartContainer,
  ChartLegendContent,
  ChartTooltipContent,
  DOCUMENT_CHART_COMPONENTS,
} from './documentCharts';

describe('document charts', () => {
  test('every chart picker template compiles with inline MDX data and a complete registered container', async () => {
    expect(CHART_COMPONENT_CATALOG.map(entry => entry.name).sort()).toEqual(Object.keys(DOCUMENT_CHART_COMPONENTS).sort());
    const templates = new Set(CHART_COMPONENT_CATALOG.map(entry => entry.template));
    for (const template of templates) {
      const code = String(await compile(template, { outputFormat: 'function-body' }));
      const { default: Content } = await run(code, jsxRuntime);
      const html = renderToStaticMarkup(<Content components={DOCUMENT_CHART_COMPONENTS} />);
      expect(html).toContain('data-component="ChartContainer"');
      expect(html).toContain('aria-label=');
      expect(html).toContain('document-chart-description');
    }
  });

  test('config colors are per-container properties and descriptions have an accessible relationship', () => {
    const html = renderToStaticMarkup(
      <ChartContainer
        id="sales"
        config={{ orders: { label: 'Orders', theme: { light: '#123456', dark: '#abcdef' } } }}
        aria-label="Sales"
        aria-describedby="sales-note"
        description="Orders grew during the quarter."
        style={{ height: 320 }}
      >
        <span>Chart content</span>
      </ChartContainer>,
    );
    expect(html).toContain('--color-orders:light-dark(#123456, #abcdef)');
    expect(html).toContain('height:320px');
    expect(html).toContain('aria-describedby="sales-note sales-description"');
    expect(html).toContain('id="sales-description"');
    expect(html).not.toContain('<style');
  });

  test('tooltip keeps zero values, configured labels, indicators and the complete formatter payload', () => {
    const payload: TooltipPayloadEntry[] = [
      { graphicalItemId: 'orders', name: 'orders', dataKey: 'orders', value: 0, color: 'var(--color-orders)' },
    ];
    const renderContent = (content: ReactNode) => renderToStaticMarkup(
      <ChartContainer config={{ orders: { label: 'Completed orders', color: 'var(--chart-1)' } }}>{content}</ChartContainer>,
    );
    const html = renderContent(<ChartTooltipContent active payload={payload} label="January" />);
    expect(html).toContain('January');
    expect(html).toContain('Completed orders');
    expect(html).toContain('document-chart-tooltip-value">0</span>');
    expect(html).toContain('data-indicator="dot"');
    let formatterPayload: unknown;
    const formatted = renderContent(
      <ChartTooltipContent active payload={payload} formatter={(value, _name, _item, _index, allItems) => {
        formatterPayload = allItems;
        return <span>{value} orders</span>;
      }} />,
    );
    expect(formatted).toContain('0 orders');
    expect(formatterPayload).toEqual(payload);
  });

  test('pie tooltip and legend resolve category labels from arbitrary nested data', () => {
    const html = renderToStaticMarkup(
      <ChartContainer config={{ apples: { label: 'Apples', color: '#123456' } }}>
        <ChartTooltipContent active hideLabel nameKey="fruit" payload={[
          { graphicalItemId: 'fruit', name: 'orders', value: 40, payload: { fruit: 'apples' } },
        ]} />
        <ChartLegendContent nameKey="fruit" payload={[
          { value: 'apples', color: '#123456', payload: { fruit: 'apples' } },
          { value: 'Other fruit', color: '#abcdef' },
        ]} />
      </ChartContainer>,
    );
    expect(html.match(/Apples/g)).toHaveLength(2);
    expect(html).toContain('Other fruit');
    expect(html).toContain('>40</span>');
  });
});
