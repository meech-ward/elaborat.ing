/**
 * Built-in custom components.
 *
 * These are the only components with source-backed literal props. They are
 * deliberately plain: runtime interaction lives here, source editing lives
 * in the prop controls (preview frame) and the instrumentation module. No
 * component here ever reads or writes document source directly.
 */
import { useState, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { cn } from '../../lib/utils';

export function Counter(props: { initial?: number; step?: number }): ReactNode {
  const initial = typeof props.initial === 'number' ? props.initial : 0;
  const step = typeof props.step === 'number' ? props.step : 1;
  const [count, setCount] = useState(initial);
  return (
    <span
      className="not-prose"
      data-component="Counter"
      style={{ display: 'inline-flex', gap: '0.5rem', alignItems: 'center' }}
    >
      <button type="button" onClick={() => setCount((value) => value - step)} aria-label="Decrement">
        -
      </button>
      <output aria-live="polite">{count}</output>
      <button type="button" onClick={() => setCount((value) => value + step)} aria-label="Increment">
        +
      </button>
    </span>
  );
}

export function Callout(props: {
  tone?: 'info' | 'warn' | 'error';
  title?: string;
  children?: ReactNode;
}): ReactNode {
  const tone = props.tone === 'warn' || props.tone === 'error' ? props.tone : 'info';
  const toneClasses = {
    info: 'border-l-primary',
    warn: 'border-l-[var(--warn-text)]',
    error: 'border-l-[var(--code-head)]',
  }[tone];
  return (
    <aside
      className={cn(
        'not-prose my-5 border border-border border-l-4 bg-card px-4 py-3 text-sm leading-6 text-card-foreground shadow-sm',
        toneClasses,
      )}
      data-component="Callout"
      data-tone={tone}
    >
      {props.title != null && props.title !== '' ? (
        <p className="m-0 mb-1 font-medium text-foreground" data-callout-title>
          {props.title}
        </p>
      ) : null}
      <div className="[&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_p+_p]:mt-3">
        {props.children}
      </div>
    </aside>
  );
}

type ButtonVariant = 'default' | 'secondary' | 'outline' | 'ghost' | 'link';
type ButtonSize = 'default' | 'sm' | 'lg';
type BadgeVariant = 'default' | 'secondary' | 'outline';

const buttonVariants: Record<ButtonVariant, string> = {
  default:
    'bg-primary text-primary-foreground shadow-xs hover:bg-primary/90 focus-visible:ring-primary/40',
  secondary:
    'bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80 focus-visible:ring-primary/40',
  outline:
    'border border-input bg-transparent text-foreground shadow-xs hover:bg-accent hover:text-accent-foreground focus-visible:ring-primary/40',
  ghost:
    'bg-transparent text-foreground hover:bg-accent hover:text-accent-foreground focus-visible:ring-primary/40',
  link: 'bg-transparent text-primary underline-offset-4 hover:underline focus-visible:ring-primary/40',
};

const buttonSizes: Record<ButtonSize, string> = {
  default: 'h-9 px-4 py-2',
  sm: 'h-8 rounded-md px-3 text-xs',
  lg: 'h-10 rounded-md px-6',
};

const badgeVariants: Record<BadgeVariant, string> = {
  default: 'border-transparent bg-primary text-primary-foreground',
  secondary: 'border-transparent bg-secondary text-secondary-foreground',
  outline: 'border-border bg-transparent text-foreground',
};

function buttonVariant(value: ButtonVariant | undefined): ButtonVariant {
  return value && value in buttonVariants ? value : 'default';
}

function buttonSize(value: ButtonSize | undefined): ButtonSize {
  return value && value in buttonSizes ? value : 'default';
}

function badgeVariant(value: BadgeVariant | undefined): BadgeVariant {
  return value && value in badgeVariants ? value : 'default';
}

export function Button({
  className,
  variant,
  size,
  type = 'button',
  ...props
}: ComponentPropsWithoutRef<'button'> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
}): ReactNode {
  return (
    <button
      {...props}
      className={cn(
        'not-prose inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md border border-transparent text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50',
        buttonVariants[buttonVariant(variant)],
        buttonSizes[buttonSize(size)],
        className,
      )}
      data-component="Button"
      type={type}
    />
  );
}

export function Badge({
  className,
  variant,
  ...props
}: ComponentPropsWithoutRef<'span'> & { variant?: BadgeVariant }): ReactNode {
  return (
    <span
      {...props}
      className={cn(
        'not-prose inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-primary/40 focus:ring-offset-2',
        badgeVariants[badgeVariant(variant)],
        className,
      )}
      data-component="Badge"
    />
  );
}

export function Card({ className, ...props }: ComponentPropsWithoutRef<'section'>): ReactNode {
  return (
    <section
      {...props}
      className={cn(
        'not-prose my-6 rounded-lg border border-border bg-card text-card-foreground shadow-sm',
        className,
      )}
      data-component="Card"
    />
  );
}

/** A responsive, source-only document grouping for a side-by-side
 * teaching layout. It intentionally has no draggable state. */
export function Columns({ className, ...props }: ComponentPropsWithoutRef<'div'>): ReactNode {
  return (
    <div
      {...props}
      className={cn('not-prose my-6 grid grid-cols-1 gap-4 sm:grid-cols-2', className)}
      data-component="Columns"
    />
  );
}

export function CardHeader({ className, ...props }: ComponentPropsWithoutRef<'div'>): ReactNode {
  return (
    <div
      {...props}
      className={cn('not-prose flex flex-col gap-1.5 p-6', className)}
      data-component="CardHeader"
    />
  );
}

export function CardTitle({ className, ...props }: ComponentPropsWithoutRef<'h3'>): ReactNode {
  return (
    <h3
      {...props}
      className={cn('not-prose m-0 text-lg font-semibold leading-none tracking-tight', className)}
      data-component="CardTitle"
    />
  );
}

export function CardDescription({ className, ...props }: ComponentPropsWithoutRef<'p'>): ReactNode {
  return (
    <p
      {...props}
      className={cn('not-prose m-0 text-sm text-muted-foreground', className)}
      data-component="CardDescription"
    />
  );
}

export function CardContent({ className, ...props }: ComponentPropsWithoutRef<'div'>): ReactNode {
  return (
    <div
      {...props}
      className={cn('not-prose px-6 pb-6 text-sm leading-6', className)}
      data-component="CardContent"
    />
  );
}

export function CardFooter({ className, ...props }: ComponentPropsWithoutRef<'div'>): ReactNode {
  return (
    <div
      {...props}
      className={cn('not-prose flex flex-wrap items-center gap-2 px-6 pb-6', className)}
      data-component="CardFooter"
    />
  );
}

export function Alert({ className, ...props }: ComponentPropsWithoutRef<'aside'>): ReactNode {
  return (
    <aside
      {...props}
      className={cn(
        'not-prose relative my-6 w-full rounded-lg border border-border bg-card px-4 py-3 text-sm text-card-foreground shadow-sm',
        className,
      )}
      data-component="Alert"
      role="note"
    />
  );
}

export function AlertTitle({ className, ...props }: ComponentPropsWithoutRef<'h4'>): ReactNode {
  return (
    <h4
      {...props}
      className={cn('not-prose mb-1 mt-0 font-medium leading-none tracking-tight', className)}
      data-component="AlertTitle"
    />
  );
}

export function AlertDescription({ className, ...props }: ComponentPropsWithoutRef<'div'>): ReactNode {
  return (
    <div
      {...props}
      className={cn('not-prose text-muted-foreground [&_p]:leading-relaxed', className)}
      data-component="AlertDescription"
    />
  );
}

export function Separator({
  className,
  orientation = 'horizontal',
  ...props
}: ComponentPropsWithoutRef<'div'> & {
  orientation?: 'horizontal' | 'vertical';
}): ReactNode {
  const horizontal = orientation === 'horizontal';
  return (
    <div
      {...props}
      aria-orientation={orientation}
      className={cn(
        'not-prose shrink-0 bg-border',
        horizontal ? 'my-6 h-px w-full' : 'mx-3 h-full w-px self-stretch',
        className,
      )}
      data-component="Separator"
      role="separator"
    />
  );
}
