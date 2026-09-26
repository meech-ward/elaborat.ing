import { DOCUMENT_BLOCK_CATALOG } from './documentBlockCatalog';
import { CHART_COMPONENT_CATALOG } from './chartCatalog';

export type ComponentName = string;

export interface ComponentPropDefinition {
  name: string;
  type: 'string' | 'number' | 'boolean';
  defaultValue: string | number | boolean;
  description: string;
  choices?: readonly string[];
  resourceKind?: 'drawing' | 'diagram';
}

export interface ComponentDefinition {
  name: ComponentName;
  description: string;
  props: readonly ComponentPropDefinition[];
  snippet: string;
  template: string;
  editableProps: boolean;
}

export const COMPONENT_CATALOG: readonly ComponentDefinition[] = [
  ...DOCUMENT_BLOCK_CATALOG,
  ...CHART_COMPONENT_CATALOG,
  {
    name: 'Counter',
    description: 'Interactive counter (initial, step)',
    props: [
      {
        name: 'initial',
        type: 'number',
        defaultValue: 3,
        description: 'Starting value',
      },
      {
        name: 'step',
        type: 'number',
        defaultValue: 1,
        description: 'Increment step',
      },
    ],
    snippet: '<Counter initial={${1:3}} step={${2:1}} />$0',
    template: '<Counter initial={3} step={1} />',
    editableProps: true,
  },
  {
    name: 'Callout',
    description: 'Tone callout with title',
    props: [
      {
        name: 'tone',
        type: 'string',
        defaultValue: 'info',
        description: 'Callout tone: info | warn | error',
        choices: ['info', 'warn', 'error'],
      },
      {
        name: 'title',
        type: 'string',
        defaultValue: 'A note',
        description: 'Heading text',
      },
    ],
    snippet: '<Callout tone="${1|info,warn,error|}" title="${2:A note}">\n\t$0\n</Callout>',
    template: '<Callout tone="info" title="A note">\nA note body\n</Callout>',
    editableProps: true,
  },
  {
    name: 'Button',
    description: 'Styled action button (source-only props; clicks are transient)',
    props: [
      {
        name: 'variant',
        type: 'string',
        defaultValue: 'default',
        description: 'Visual treatment',
        choices: ['default', 'secondary', 'outline', 'ghost', 'link'],
      },
      {
        name: 'size',
        type: 'string',
        defaultValue: 'default',
        description: 'Button size',
        choices: ['default', 'sm', 'lg'],
      },
    ],
    snippet: '<Button variant="${1|default,secondary,outline,ghost,link|}" size="${2|default,sm,lg|}">$0</Button>',
    template: '<Button>Continue</Button>',
    editableProps: false,
  },
  {
    name: 'Badge',
    description: 'Compact status badge',
    props: [
      {
        name: 'variant',
        type: 'string',
        defaultValue: 'default',
        description: 'Visual treatment',
        choices: ['default', 'secondary', 'outline'],
      },
    ],
    snippet: '<Badge variant="${1|default,secondary,outline|}">$0</Badge>',
    template: '<Badge>Draft</Badge>',
    editableProps: false,
  },
  {
    name: 'Card',
    description: 'Framed document card',
    props: [],
    snippet: '<Card>\n\t$0\n</Card>',
    template: '<Card>\n  <CardHeader>\n    <CardTitle>Release status</CardTitle>\n    <CardDescription>What readers should know next.</CardDescription>\n  </CardHeader>\n  <CardContent>\n    Card body\n  </CardContent>\n  <CardFooter>\n    <Button>Continue</Button>\n  </CardFooter>\n</Card>',
    editableProps: false,
  },
  {
    name: 'Columns',
    description: 'Responsive two-column document group',
    props: [],
    snippet: '<Columns>\n\t$0\n</Columns>',
    template: '<Columns>\n  <Card>\n    <CardContent>First column</CardContent>\n  </Card>\n  <Card>\n    <CardContent>Second column</CardContent>\n  </Card>\n</Columns>',
    editableProps: false,
  },
  {
    name: 'CardHeader',
    description: 'Card heading group',
    props: [],
    snippet: '<CardHeader>\n\t$0\n</CardHeader>',
    template: '<CardHeader>\n  <CardTitle>Card title</CardTitle>\n</CardHeader>',
    editableProps: false,
  },
  {
    name: 'CardTitle',
    description: 'Card title',
    props: [],
    snippet: '<CardTitle>$0</CardTitle>',
    template: '<CardTitle>Card title</CardTitle>',
    editableProps: false,
  },
  {
    name: 'CardDescription',
    description: 'Muted card description',
    props: [],
    snippet: '<CardDescription>$0</CardDescription>',
    template: '<CardDescription>Supporting detail</CardDescription>',
    editableProps: false,
  },
  {
    name: 'CardContent',
    description: 'Card body',
    props: [],
    snippet: '<CardContent>\n\t$0\n</CardContent>',
    template: '<CardContent>Card body</CardContent>',
    editableProps: false,
  },
  {
    name: 'CardFooter',
    description: 'Card footer actions',
    props: [],
    snippet: '<CardFooter>\n\t$0\n</CardFooter>',
    template: '<CardFooter><Button>Continue</Button></CardFooter>',
    editableProps: false,
  },
  {
    name: 'Alert',
    description: 'Framed note with optional title and description',
    props: [],
    snippet: '<Alert>\n\t$0\n</Alert>',
    template: '<Alert>\n  <AlertTitle>Heads up</AlertTitle>\n  <AlertDescription>Review this detail before continuing.</AlertDescription>\n</Alert>',
    editableProps: false,
  },
  {
    name: 'AlertTitle',
    description: 'Alert title',
    props: [],
    snippet: '<AlertTitle>$0</AlertTitle>',
    template: '<AlertTitle>Heads up</AlertTitle>',
    editableProps: false,
  },
  {
    name: 'AlertDescription',
    description: 'Alert supporting detail',
    props: [],
    snippet: '<AlertDescription>$0</AlertDescription>',
    template: '<AlertDescription>Review this detail before continuing.</AlertDescription>',
    editableProps: false,
  },
  {
    name: 'Separator',
    description: 'Horizontal document separator',
    props: [],
    snippet: '<Separator />$0',
    template: '<Separator />',
    editableProps: false,
  },
  {
    name: 'Drawing',
    description: 'Embed a native drawing file',
    props: [
      {
        name: 'src',
        type: 'string',
        defaultValue: 'drawings/example.excalidraw',
        description: 'Workspace path to the drawing file',
        resourceKind: 'drawing',
      },
    ],
    snippet: '<Drawing src="${1:drawings/example.excalidraw}" />$0',
    template: '<Drawing src="drawings/example.excalidraw" />',
    editableProps: false,
  },
  {
    name: 'Diagram',
    description: 'Embed a structured D2 diagram',
    props: [
      {
        name: 'src',
        type: 'string',
        defaultValue: 'diagrams/flow.d2',
        description: 'Workspace path to the diagram file',
        resourceKind: 'diagram',
      },
    ],
    snippet: '<Diagram src="${1:diagrams/flow.d2}" />$0',
    template: '<Diagram src="diagrams/flow.d2" />',
    editableProps: false,
  },
];

export function getComponentDefinition(name: string, catalog = COMPONENT_CATALOG): ComponentDefinition | undefined {
  return catalog.find((entry) => entry.name === name);
}
