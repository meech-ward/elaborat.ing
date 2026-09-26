import { expect, test } from 'bun:test';
import { renderMessageSchema } from './protocol';
import { COMPONENT_CATALOG } from '../document/componentCatalog';

test('parent catalog transport admits registered compound names, not arbitrary member paths', () => {
  const message = {
    kind: 'render', session: 'session-components', revision: 1, code: 'return {};', slots: [],
    authoring: { format: 'mdx', boundaries: [], availableResourcePaths: [],
      components: COMPONENT_CATALOG.map(({name, description}) => ({name, description})),
    },
  };
  expect(renderMessageSchema.safeParse(message).success).toBe(true);
  for (const name of ['Instruction.__proto__', 'window.location', 'Instruction.Action.More', 'Instruction["Action"]']) {
    expect(renderMessageSchema.safeParse({...message, authoring: {...message.authoring, components: [{name,description:'forged'}]}}).success).toBe(false);
  }
});
