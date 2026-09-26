import type { SourcePatch } from '../document';
import type { ComponentSlot } from './instrumentation';
import { encodePropLiteral } from './protocol';

export const COMPONENT_VALUE_PROPS = {
  Note: ['title'], Warning: ['title'], Important: ['title'],
  ExampleCard: ['title'], SideBySide: ['ratio'], Instruction: ['ratio'],
} as const;

/** The parent owns both the parsed slot and the allowable property set. */
export function componentValuePatch(
  source: string,
  slots: readonly ComponentSlot[],
  request: { slot: number; prop: 'title' | 'ratio'; value: string },
): SourcePatch | null {
  const slot = slots.find((entry) => entry.index === request.slot);
  const allowed: readonly string[] = slot && Object.hasOwn(COMPONENT_VALUE_PROPS, slot.element)
    ? COMPONENT_VALUE_PROPS[slot.element as keyof typeof COMPONENT_VALUE_PROPS] : [];
  if (!slot?.supported || !allowed.includes(request.prop))
    throw new Error('This component property has no editable source mapping.');
  if (request.value.length > 32_000) throw new Error('Component text is too long.');
  if (request.prop === 'ratio') {
    const parts = request.value.split(':');
    if (parts.length !== 2 || !parts.every((part) => /^\d+(?:\.\d+)?$/.test(part) && Number(part) > 0 && Number(part) <= 100_000))
      throw new Error('Column ratio must contain two positive numbers.');
  }
  const property = slot.props.find((entry) => entry.name === request.prop);
  if (property) {
    if (property.kind !== 'string' || source.slice(property.from, property.to) !== property.expected)
      throw new Error('Component property no longer matches its source.');
    const insert = encodePropLiteral(property.syntax, 'string', request.value);
    return insert === property.expected ? null : { from: property.from, to: property.to, expected: property.expected, insert };
  }
  // Only a parser-authorized literal-only opening tag may gain an omitted
  // property. Insert immediately after its exact name, preserving all bytes.
  const prefix = `<${slot.element}`;
  const from = slot.from + prefix.length;
  if (source.slice(slot.from, from) !== prefix || !/[\s/>]/.test(source[from] ?? '') || from >= slot.to)
    throw new Error('Component opening tag no longer matches its source.');
  return { from, to: from, expected: '', insert: ` ${request.prop}=${encodePropLiteral('quoted-double', 'string', request.value)}` };
}
