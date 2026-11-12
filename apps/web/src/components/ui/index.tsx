import Link from 'next/link';
import type { ReactNode } from 'react';
import { DOTTED_ICONS, ICON_PATHS, type IconName } from '@lumra/ui';

export type { IconName };

/**
 * Presentational primitives of the Lumra design system (`@lumra/ui` tokens + `lm-` classes).
 * Server-safe: no hooks, no state.
 */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'lumen';
type ButtonSize = 'sm' | 'md' | 'lg';

/** Class list for a Lumra button (works on `<button>`, `<a>` and `<Link>`). */
export function buttonClass(
  variant: ButtonVariant = 'primary',
  size: ButtonSize = 'md',
  extra = '',
): string {
  return ['lm-btn', `lm-btn-${variant}`, size === 'md' ? '' : `lm-btn-${size}`, extra]
    .filter(Boolean)
    .join(' ');
}

/** Lumra line icon; decorative unless `label` is given. */
export function Icon({
  name,
  size = 20,
  label,
  className,
}: {
  name: IconName;
  size?: number;
  label?: string;
  className?: string;
}) {
  return (
    <svg
      className={className ? `lm-icon ${className}` : 'lm-icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={DOTTED_ICONS.has(name) ? 3 : 1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

/**
 * The typeset mark: "lumra" in Warbler Banner with a lumen dot. Stands in until a logo is
 * drawn. Screen readers hear "Lumra".
 */
export function Wordmark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <span
      className={className ? `lm-wordmark ${className}` : 'lm-wordmark'}
      style={{ fontSize: size }}
    >
      <span aria-hidden="true">
        lumra
        <span className="lm-wordmark-dot" />
      </span>
      <span className="sr-only">Lumra</span>
    </span>
  );
}

/**
 * Creator top bar: the wordmark (linking home) or a back link, context, and the screen's
 * actions. The primary action always sits rightmost.
 */
export function AppHeader({
  back,
  children,
  actions,
}: {
  back?: { href: string; label: string };
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="lm-appbar">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {back ? (
          <Link href={back.href} className={buttonClass('ghost', 'md', '-ml-2 px-2')}>
            <Icon name="arrow-left" />
            <span>{back.label}</span>
          </Link>
        ) : (
          <Link href="/" className="-my-1 inline-flex min-h-11 items-center rounded-sm">
            <Wordmark size={28} />
          </Link>
        )}
        {children}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-1 sm:gap-2">{actions}</div> : null}
    </header>
  );
}

/** Status tag: a word, plus a dot or icon — never colour alone. */
export function Tag({
  tone,
  icon,
  dot,
  children,
  className,
}: {
  tone?: 'published' | 'ready' | 'failed' | 'pro' | 'surface';
  icon?: IconName;
  dot?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={['lm-tag', tone ? `lm-tag-${tone}` : '', className ?? ''].join(' ').trim()}>
      {dot ? <span aria-hidden="true" className="lm-tag-dot" /> : null}
      {icon ? <Icon name={icon} size={14} /> : null}
      {children}
    </span>
  );
}
