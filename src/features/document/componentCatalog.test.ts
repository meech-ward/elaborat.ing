import { describe, expect, test } from 'bun:test';
import { CHART_COMPONENT_CATALOG } from './chartCatalog';
import {
  COMPONENT_CATALOG,
  getComponentDefinition,
  type ComponentName,
} from './componentCatalog';

const EXPECTED_NAMES: readonly ComponentName[] = [
  'Counter',
  'Callout',
  'Drawing',
  'Diagram',
  'Button',
  'Badge',
  'Card',
  'CardHeader',
  'CardTitle',
  'CardDescription',
  'CardContent',
  'CardFooter',
  'Alert',
  'AlertTitle',
  'AlertDescription',
  'Separator',
  'Columns',
  'Note', 'Warning', 'Important', 'Instruction', 'Instruction.Action',
  'Instruction.Implementation', 'SideBySide', 'SideBySide.Block',
  'SideBySideBlock', 'ExampleCard', 'Tabs', 'Tab',
  ...CHART_COMPONENT_CATALOG.map(entry => entry.name),
];

describe('componentCatalog', () => {
  test('catalog lists the trusted components exactly once', () => {
    expect(COMPONENT_CATALOG.map((entry) => entry.name).sort()).toEqual(
      [...EXPECTED_NAMES].sort(),
    );
    expect(new Set(COMPONENT_CATALOG.map((entry) => entry.name)).size).toBe(
      EXPECTED_NAMES.length,
    );
  });

  test('lookup resolves every catalog entry and returns undefined for unknown names', () => {
    for (const name of EXPECTED_NAMES) {
      expect(getComponentDefinition(name)?.name).toBe(name);
    }
    expect(getComponentDefinition('Unknown')).toBeUndefined();
    expect(getComponentDefinition('')).toBeUndefined();
    expect(getComponentDefinition('counter')).toBeUndefined();
  });

  test('Counter documents numeric initial/step defaults', () => {
    const counter = getComponentDefinition('Counter');
    const byName = Object.fromEntries(
      (counter?.props ?? []).map((prop) => [prop.name, prop]),
    );
    expect(byName['initial']?.type).toBe('number');
    expect(byName['initial']?.defaultValue).toBe(3);
    expect(byName['step']?.type).toBe('number');
    expect(byName['step']?.defaultValue).toBe(1);
  });

  test('Callout documents tone enumeration and title default', () => {
    const callout = getComponentDefinition('Callout');
    const byName = Object.fromEntries(
      (callout?.props ?? []).map((prop) => [prop.name, prop]),
    );
    expect(byName['tone']?.type).toBe('string');
    expect(byName['tone']?.defaultValue).toBe('info');
    expect(byName['tone']?.choices).toEqual(['info', 'warn', 'error']);
    expect(byName['title']?.type).toBe('string');
    expect(byName['title']?.defaultValue).toBe('A note');
  });

  test('Drawing and Diagram expose src defaults with resource kinds', () => {
    const drawing = getComponentDefinition('Drawing');
    expect(drawing?.props).toHaveLength(1);
    expect(drawing?.props[0]?.name).toBe('src');
    expect(drawing?.props[0]?.defaultValue).toBe(
      'drawings/example.excalidraw',
    );
    expect(drawing?.props[0]?.resourceKind).toBe('drawing');

    const diagram = getComponentDefinition('Diagram');
    expect(diagram?.props).toHaveLength(1);
    expect(diagram?.props[0]?.name).toBe('src');
    expect(diagram?.props[0]?.defaultValue).toBe('diagrams/flow.d2');
    expect(diagram?.props[0]?.resourceKind).toBe('diagram');
  });

  test('document primitives expose source-only variants and concrete nested templates', () => {
    const button = getComponentDefinition('Button');
    const buttonProps = Object.fromEntries(
      (button?.props ?? []).map((prop) => [prop.name, prop]),
    );
    expect(buttonProps['variant']?.choices).toEqual([
      'default',
      'secondary',
      'outline',
      'ghost',
      'link',
    ]);
    expect(buttonProps['size']?.choices).toEqual(['default', 'sm', 'lg']);
    expect(button?.editableProps).toBe(false);
    expect(getComponentDefinition('Badge')?.editableProps).toBe(false);
    expect(getComponentDefinition('Alert')?.editableProps).toBe(false);
    expect(getComponentDefinition('Card')?.template).toContain('<CardHeader>');
    expect(getComponentDefinition('Card')?.template).toContain('<CardContent>');
    expect(getComponentDefinition('Alert')?.template).toContain(
      '<AlertDescription>',
    );
    expect(getComponentDefinition('Separator')?.template).toBe('<Separator />');
    expect(getComponentDefinition('Columns')?.editableProps).toBe(false);
    expect(getComponentDefinition('Columns')?.template).toContain('<Card>');
  });

  test('snippets are full tags with Monaco placeholders and a final $0', () => {
    for (const entry of COMPONENT_CATALOG) {
      expect(entry.snippet).toContain('<' + entry.name);
      expect(entry.snippet).toContain('$');
      expect(entry.snippet).toContain('$0');
    }
    const callout = getComponentDefinition('Callout');
    expect(callout?.snippet).toContain('</Callout>');
    expect(callout?.snippet).toContain('\n');
  });

  test('templates are concrete MDX without Monaco placeholders', () => {
    for (const entry of COMPONENT_CATALOG) {
      expect(entry.template).toContain('<' + entry.name);
      expect(entry.template).not.toContain('$');
      expect(entry.template).not.toBe(entry.snippet);
    }
    expect(getComponentDefinition('Callout')?.template).toContain(
      '</Callout>',
    );
    expect(getComponentDefinition('Counter')?.template).toContain(
      'initial={3}',
    );
  });

  test('only components with implemented literal controls advertise them', () => {
    const controlled = new Set(['Counter', 'Callout', 'Note', 'Warning', 'Important', 'ExampleCard', 'SideBySide', 'Instruction']);
    for (const entry of COMPONENT_CATALOG) {
      expect(entry.editableProps).toBe(controlled.has(entry.name));
    }
  });
});
