/**
 * The app's built-in components as the component preview's frame provides
 * them to a note: the same ones the app's preview frame gives
 * (src/preview/preview-entry.tsx), without its editing controls. Code blocks
 * show as plain code in the note's type, which keeps the highlighter's
 * grammars out of the frame. Charts are the app's, which the
 * frame loads only for a note with a chart (runtime.tsx); until then, or
 * where they do not load, a chart shows as a box with its description that
 * says charts show in elaborat.ing. Drawing and Diagram come from the frame,
 * which draws them from the server's pictures (runtime.tsx).
 */
import { isValidElement, type ComponentProps, type ReactNode } from "react"
import { CodeCopyButton } from "@/features/rendered/CodeCopyButton"
import { isDocumentPath } from '@/features/document/documentPaths'
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

/** Chat previews describe the reference without fetching another document. */
export function DocumentBox({ src, title, url }: {src?:unknown;title?:unknown;url?:string|null}): ReactNode {
  const path = typeof src === 'string' && isDocumentPath(src) ? src : null;
  return <EmbedBox className="not-prose" data-document-reference={path ?? ''}
    caption={<><span>Document</span>{path && <code>{path}</code>}</>}
    message={<>
      {typeof title === 'string' && title && <strong className="mb-1 block text-body">{title}</strong>}
      {path ? <>Expand and edit this document in elaborat.ing.{url && <> <a href={url}>Open document</a></>}</> : 'Choose a project Markdown or MDX file in Source.'}
    </>} />;
}

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

/** Plain code keeps the highlighter out of this nested frame. Copy uses its source. */
function CodeBlock({ children, ...props }: ComponentProps<"pre">) {
  if (!isValidElement<{ children?: unknown; className?: string }>(children) || typeof children.props.children !== "string") {
    return <pre {...props}>{children}</pre>
  }
  const language = /(?:^|\s)language-(\S+)/.exec(children.props.className ?? "")?.[1] ?? "text"
  // The Markdown HTML compiler adds one terminal newline, as the server does.
  const code = children.props.children.replace(/\n$/, "")
  return (
    <div className="not-prose document-code" data-code-language={language}>
      <div className="document-code-label">
        <span>{language}</span>
        <span className="document-code-actions"><CodeCopyButton code={code} /></span>
      </div>
      <pre {...props} tabIndex={0} aria-label={`${language === "text" ? "Plain text" : language} code`}><code>{code}</code></pre>
    </div>
  )
}

export const PREVIEW_COMPONENTS: Record<string, unknown> = {
  ...CHARTS,
  pre: CodeBlock,
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
  Document: DocumentBox,
}
