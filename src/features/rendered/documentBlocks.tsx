import {
  Children,
  Fragment,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react';
import { cn } from '../../lib/utils';

type BlockProps = ComponentPropsWithoutRef<'div'>;
type TitledProps = Omit<BlockProps, 'title'> & { title?: ReactNode };

/** Keep JSX fragments and Markdown whitespace from becoming layout columns. */
function blockChildren(children: ReactNode): ReactNode[] {
  return Children.toArray(children).flatMap((child) => {
    if (isValidElement<{ children?: ReactNode }>(child) && child.type === Fragment) {
      return blockChildren(child.props.children);
    }
    return typeof child === 'string' && !child.trim() ? [] : [child];
  });
}

function Aside({ kind, title = kind, children, className, ...props }: TitledProps & {
  kind: 'Note' | 'Warning' | 'Important';
}) {
  const titleId = useId();
  return (
    <aside
      {...props}
      className={cn('not-prose document-block document-aside', className)}
      data-component={kind}
      aria-labelledby={title ? titleId : undefined}
      aria-label={title ? undefined : kind}
    >
      {title && <p id={titleId} className="document-block-title">{title}</p>}
      <div className="document-block-body">{children}</div>
    </aside>
  );
}

export function Note(props: TitledProps) {
  return <Aside {...props} kind="Note" />;
}

export function Warning(props: TitledProps) {
  return <Aside {...props} kind="Warning" />;
}

export function Important(props: TitledProps) {
  return <Aside {...props} kind="Important" />;
}

export type DocumentWidth = 'normal' | 'extended' | 'extended-2xl' | 'extended-3xl';
export type SideBySideProps = BlockProps & {
  ratio?: string;
  width?: DocumentWidth;
  center?: boolean;
  /** Minimum width of each pane in pixels. */
  minWidth?: number;
  readOnly?: boolean;
  /** One source-layout transaction after a completed gesture, never on movement. */
  onRatioCommit?: (ratio: string) => void;
};

function SideBySideRoot({
  children,
  ratio = '1:1',
  width = 'extended',
  center = false,
  minWidth = 120,
  readOnly = false,
  onRatioCommit,
  className,
  style,
  ...props
}: SideBySideProps) {
  const parts = ratio.split(':').map(Number);
  const paired = parts.length === 2 && parts.every((part) => Number.isFinite(part) && part > 0);
  const initial = paired ? parts[0] / (parts[0] + parts[1]) * 100 : 100;
  const [local, setLocal] = useState({ ratio, value: initial });
  // Source changes (including Undo) win without remounting any child content.
  // Remember the new source key too, so Undo to a previously seen ratio cannot
  // revive that ratio's stale local drag value.
  if (local.ratio !== ratio) setLocal({ ratio, value: initial });
  const value = local.ratio === ratio ? local.value : initial;
  const columns = paired ? `minmax(0, ${value}fr) minmax(0, ${100 - value}fr)` : 'minmax(0, 1fr)';
  const items = blockChildren(children);
  const columnsRef = useRef<HTMLDivElement>(null);
  const paneId = useId();
  const [availableWidth, setAvailableWidth] = useState(0);
  const gesture = useRef<{
    ratio: string; start: number; value: number; pointerId?: number;
    x?: number; width: number; direction: number;
    cleanup?: () => void;
  } | null>(null);
  const minimumPixels = Number.isFinite(minWidth) ? Math.max(1, minWidth) : 120;
  const minimum = availableWidth > 0 ? Math.min(50, minimumPixels / availableWidth * 100) : 0;
  const resizable = paired && items.length > 1 && !readOnly;

  useEffect(() => {
    const element = columnsRef.current;
    if (!element) return;
    const measure = () => setAvailableWidth(Math.max(0,
      element.getBoundingClientRect().width - (parseFloat(getComputedStyle(element).columnGap) || 0)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
      gesture.current?.cleanup?.();
    };
  }, []);

  function finish(cancel = false) {
    const current = gesture.current;
    gesture.current = null;
    current?.cleanup?.();
    if (!current || current.ratio !== ratio) return;
    if (cancel) {
      setLocal({ ratio, value: current.start });
    } else if (Math.abs(current.value - current.start) >= 0.05) {
      const left = Math.max(0.1, Math.min(99.9, Math.round(current.value * 10) / 10));
      setLocal({ ratio, value: left });
      onRatioCommit?.(`${left}:${Math.round((100 - left) * 10) / 10}`);
    }
  }

  function update(next: number) {
    const current = gesture.current;
    if (!current || current.ratio !== ratio) return;
    const limit = current.width > 0 ? Math.min(50, minimumPixels / current.width * 100) : 50;
    current.value = Math.min(100 - limit, Math.max(limit, next));
    setLocal({ ratio, value: current.value });
  }
  return (
    <div
      {...props}
      className={cn('not-prose document-layout', className)}
      data-component="SideBySide"
      data-width={width}
      style={{ '--document-columns': columns, '--document-left': value / 100, ...style } as CSSProperties}
    >
      <div ref={columnsRef} className="document-columns" style={{ alignItems: center ? 'center' : 'start' }}>
        {items.map((child, index) => (
          <div id={index === 0 ? paneId : undefined} className="document-block-body document-column" key={isValidElement(child) ? child.key ?? index : index}>
            {child}
          </div>
        ))}
        {resizable && <div
          className="document-column-separator"
          role="separator"
          aria-label="Resize columns"
          aria-orientation="vertical"
          aria-controls={paneId}
          aria-valuemin={Math.floor(Math.min(value, minimum))}
          aria-valuemax={Math.ceil(Math.max(value, 100 - minimum))}
          aria-valuenow={Math.round(value)}
          aria-valuetext={`${Math.round(value)}% first column`}
          tabIndex={0}
          contentEditable={false}
          onPointerDown={(event) => {
            if (event.button !== 0 || !event.isPrimary) return;
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.focus({ preventScroll: true });
            event.currentTarget.setPointerCapture(event.pointerId);
            gesture.current = { ratio, start: value, value, pointerId: event.pointerId,
              x: event.clientX, width: availableWidth,
              direction: getComputedStyle(event.currentTarget).direction === 'rtl' ? -1 : 1 };
            // The enclosing document editor may reclaim focus on pointerdown.
            // Escape must still cancel capture, but only this active gesture
            // installs a document listener; every end/unmount removes it.
            const ownerDocument = event.currentTarget.ownerDocument;
            const cancel = (key: KeyboardEvent) => {
              if (key.key !== 'Escape') return;
              key.preventDefault();
              key.stopPropagation();
              finish(true);
            };
            ownerDocument.addEventListener('keydown', cancel, true);
            gesture.current.cleanup = () => ownerDocument.removeEventListener('keydown', cancel, true);
          }}
          onPointerMove={(event) => {
            const current = gesture.current;
            if (!current || current.pointerId !== event.pointerId || !current.width) return;
            update(current.start + (event.clientX - current.x!) / current.width * 100 * current.direction);
          }}
          onPointerUp={(event) => {
            if (gesture.current?.pointerId !== event.pointerId) return;
            event.stopPropagation();
            finish();
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={() => finish(true)}
          onLostPointerCapture={() => finish(true)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              finish(true);
              return;
            }
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            event.stopPropagation();
            if (gesture.current?.pointerId !== undefined) return;
            const direction = getComputedStyle(event.currentTarget).direction === 'rtl' ? -1 : 1;
            gesture.current ??= { ratio, start: value, value, width: availableWidth, direction };
            update(event.key === 'Home' ? 0 : event.key === 'End' ? 100
              : gesture.current.value + (event.key === 'ArrowRight' ? 1 : -1) * direction * (event.shiftKey ? 10 : 1));
          }}
          onKeyUp={(event) => {
            if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
              event.stopPropagation();
              if (gesture.current?.pointerId === undefined) finish();
            }
          }}
          onBlur={() => { if (gesture.current?.pointerId === undefined) finish(); }}
        ><span aria-hidden="true" /></div>}
      </div>
    </div>
  );
}

export function SideBySideBlock({ children, className, ...props }: BlockProps) {
  return <div {...props} className={cn('not-prose document-block-body', className)}>{children}</div>;
}

export const SideBySide = Object.assign(SideBySideRoot, { Block: SideBySideBlock });

function InstructionAction({ step, children, className, ...props }: BlockProps & { step?: number }) {
  return (
    <div {...props} className={cn('not-prose document-block document-action', className)} data-component="Instruction.Action">
      {step !== undefined && <p className="document-block-title">Step {step}</p>}
      <div className="document-block-body">{children}</div>
    </div>
  );
}

function InstructionImplementation({ children, className, ...props }: BlockProps) {
  return <div {...props} className={cn('not-prose document-block-body', className)} data-component="Instruction.Implementation">{children}</div>;
}

function InstructionRoot({ children, ratio = '3:5', ...props }: SideBySideProps) {
  const content = blockChildren(children);
  const implementation = content.filter((child) => isValidElement(child) && child.type === InstructionImplementation);
  const action = content.filter((child) => !isValidElement(child) || child.type !== InstructionImplementation);
  return (
    <SideBySide {...props} ratio={implementation.length ? ratio : '1'}>
      <div className="document-instruction-stack">{action}</div>
      {implementation.length > 0 && <div className="document-instruction-stack">{implementation}</div>}
    </SideBySide>
  );
}

export const Instruction = Object.assign(InstructionRoot, {
  Action: InstructionAction,
  Implementation: InstructionImplementation,
});

export function ExampleCard({ children, title, className, ...props }: TitledProps) {
  return (
    <div {...props} className={cn('not-prose document-block document-example', className)} data-component="ExampleCard">
      {title && <p className="document-block-title">{title}</p>}
      <div className="document-block-body">{children}</div>
    </div>
  );
}

type TabProps = { name: string; current?: boolean; children?: ReactNode };

/** A descriptor inside Tabs; remains readable when used on its own. */
export function Tab({ children }: TabProps) {
  return <div className="not-prose document-block-body">{children}</div>;
}

export function Tabs({ children, current, className, 'aria-label': label = 'Content options', ...props }: BlockProps & { current?: string }) {
  const items = blockChildren(children);
  const tabs = items.filter((child): child is ReactElement<TabProps> => isValidElement<TabProps>(child) && child.type === Tab);
  const otherContent = items.filter((child) => !isValidElement(child) || child.type !== Tab);
  const initialIndex = tabs.findIndex((tab) => current ? tab.props.name === current : tab.props.current);
  const [selected, setSelected] = useState(Math.max(0, initialIndex));
  const activeIndex = selected < tabs.length ? selected : Math.max(0, initialIndex);
  const groupId = useId();
  return (
    <div {...props} className={cn('not-prose document-tabs', className)} data-component="Tabs">
      {tabs.length > 0 && <>
        <div className="document-tab-list" role="tablist" aria-label={label}>
          {tabs.map((tab, index) => (
            <button
              type="button"
              role="tab"
              id={`${groupId}-tab-${index}`}
              aria-controls={`${groupId}-panel-${index}`}
              aria-selected={index === activeIndex}
              tabIndex={index === activeIndex ? 0 : -1}
              key={tab.key ?? index}
              onClick={() => setSelected(index)}
              onKeyDown={(event) => {
                const direction = getComputedStyle(event.currentTarget).direction === 'rtl' ? -1 : 1;
                const next = event.key === 'Home' ? 0
                  : event.key === 'End' ? tabs.length - 1
                    : event.key === 'ArrowRight' ? (index + direction + tabs.length) % tabs.length
                      : event.key === 'ArrowLeft' ? (index - direction + tabs.length) % tabs.length
                        : undefined;
                if (next === undefined) return;
                event.preventDefault();
                setSelected(next);
                const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
                buttons?.[next]?.focus();
              }}
            >{tab.props.name}</button>
          ))}
        </div>
        {tabs.map((tab, index) => (
          <div
            className="document-block-body document-tab-panel"
            role="tabpanel"
            id={`${groupId}-panel-${index}`}
            aria-labelledby={`${groupId}-tab-${index}`}
            hidden={index !== activeIndex}
            tabIndex={0}
            key={tab.key ?? index}
          >{tab.props.children}</div>
        ))}
      </>}
      {otherContent}
    </div>
  );
}
