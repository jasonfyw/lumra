import Link from 'next/link';

/** Discreet "Made with Lumra" mark for galleries with `brandingVisible` (Free plan, T17). */
export function LumraBadge() {
  return (
    <Link
      href="/"
      className="inline-flex min-h-11 items-center gap-2 rounded-full px-3 text-xs font-medium text-[var(--color-ink-muted)] transition-colors duration-[var(--duration-fast)] hover:text-[var(--color-ink)]"
    >
      <span aria-hidden="true" className="size-2 rounded-full bg-[var(--color-ink)]" />
      Made with Lumra
    </Link>
  );
}
