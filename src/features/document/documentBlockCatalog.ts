import type { ComponentDefinition } from './componentCatalog';

function block(name: string, description: string, template: string, props: ComponentDefinition['props'] = []): ComponentDefinition {
  return { name, description, props, template, snippet: template + '$0', editableProps: ['Note', 'Warning', 'Important', 'ExampleCard', 'SideBySide', 'Instruction'].includes(name) };
}
const title = [{ name: 'title', type: 'string' as const, defaultValue: 'A note', description: 'Optional heading' }];
const ratio = [
  { name: 'ratio', type: 'string' as const, defaultValue: '1:1', description: 'Saved column ratio, for example 1:1 or 37.5:62.5' },
  { name: 'minWidth', type: 'number' as const, defaultValue: 120, description: 'Minimum pane width in pixels' },
];
export const DOCUMENT_BLOCK_CATALOG: readonly ComponentDefinition[] = [
  block('Note', 'An editable supporting note', '<Note>\n\nA useful detail.\n\n</Note>', title),
  block('Warning', 'A caution for the reader', '<Warning>\n\nCheck this before continuing.\n\n</Warning>', title),
  block('Important', 'An important detail', '<Important>\n\nKeep this in mind.\n\n</Important>', title),
  block('Instruction', 'Paired editable action and implementation with a saved divider', '<Instruction>\n  <Instruction.Action step={1}>\n\nCreate the configuration file.\n\n  </Instruction.Action>\n  <Instruction.Implementation>\n\n```json\n{"ready": true}\n```\n\n  </Instruction.Implementation>\n</Instruction>', ratio),
  block('Instruction.Action', 'Instruction action with an optional step number', '<Instruction.Action step={1}>\n\nDescribe the action.\n\n</Instruction.Action>', [{ name: 'step', type: 'number', defaultValue: 1, description: 'Step number' }]),
  block('Instruction.Implementation', 'Code or content paired with an instruction', '<Instruction.Implementation>\n\n```js\nconst ready = true\n```\n\n</Instruction.Implementation>'),
  block('SideBySide', 'Editable paired content with a saved draggable divider', '<SideBySide ratio="1:1">\n  <SideBySide.Block>\n\nFirst perspective.\n\n  </SideBySide.Block>\n  <SideBySide.Block>\n\nSecond perspective.\n\n  </SideBySide.Block>\n</SideBySide>', ratio),
  block('SideBySide.Block', 'One side of paired document content', '<SideBySide.Block>\n\nSupporting content.\n\n</SideBySide.Block>'),
  block('SideBySideBlock', 'Alias for SideBySide.Block', '<SideBySideBlock>\n\nSupporting content.\n\n</SideBySideBlock>'),
  block('ExampleCard', 'A framed example', '<ExampleCard title="Example">\n\nA concrete example goes here.\n\n</ExampleCard>', title),
  block('Tabs', 'Named alternatives; tab selection is transient', '<Tabs current="Overview">\n  <Tab name="Overview">\n\nStart here.\n\n  </Tab>\n  <Tab name="Details">\n\nSupporting details.\n\n  </Tab>\n</Tabs>', [{ name: 'current', type: 'string', defaultValue: 'Overview', description: 'Initially selected tab name' }]),
  block('Tab', 'Named content inside Tabs', '<Tab name="Overview">\n\nTab content.\n\n</Tab>', [{ name: 'name', type: 'string', defaultValue: 'Overview', description: 'Tab label' }]),
];
