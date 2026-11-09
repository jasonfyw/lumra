import Link from 'next/link';
import { Icon, Wordmark, buttonClass } from '@/components/ui';

export default function HomePage() {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="mx-auto flex w-full max-w-[var(--app-max)] items-center justify-between gap-4 px-4 py-3 sm:px-8 sm:py-4">
        <Wordmark size={28} />
        <nav aria-label="Main" className="flex items-center gap-1">
          <Link href="/pricing" className={buttonClass('ghost')}>
            Pricing
          </Link>
          <Link href="/auth" className={buttonClass('ghost')}>
            Sign in
          </Link>
        </nav>
      </header>

      <main className="mx-auto grid w-full max-w-[var(--app-max)] flex-1 content-start items-center gap-12 px-4 pt-10 pb-16 sm:px-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:content-center lg:gap-16 lg:py-24">
        <div className="flex flex-col items-start gap-6">
          <h1 className="lm-hero-title max-w-[12ch] text-balance">Share photos beautifully.</h1>
          <p className="lm-body-lg max-w-md text-[var(--color-ink-muted)]">
            Create a gallery, drop in your photos, and send one link. No account needed to start.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Link href="/new" className={buttonClass('primary', 'lg')}>
              <Icon name="plus" size={18} />
              Create gallery
            </Link>
          </div>
        </div>
        <Mosaic />
      </main>
    </div>
  );
}

/**
 * The cover art from the design system: the product's own justified grid in token colours —
 * one lumen frame, placeholder tiles with progress, and a selection check. Decorative.
 */
function Mosaic() {
  return (
    <div aria-hidden="true" className="w-full overflow-hidden">
      <svg viewBox="0 0 520 320" className="block h-auto w-full" role="presentation">
        <g>
          <rect x="0" y="0" width="136" height="104" fill="var(--color-border)" />
          <rect x="144" y="0" width="88" height="104" fill="var(--color-lumen-soft)" />
          <rect x="240" y="0" width="280" height="104" fill="var(--color-ink)" />

          <rect x="0" y="112" width="96" height="120" fill="var(--color-hairline)" />
          <rect x="12" y="212" width="72" height="4" rx="2" fill="var(--color-surface)" />
          <rect x="12" y="212" width="46" height="4" rx="2" fill="var(--color-lumen)" />
          <rect x="104" y="112" width="184" height="120" fill="var(--color-lumen)" />
          <rect x="296" y="112" width="224" height="120" fill="var(--color-border)" />
          <circle cx="316" cy="132" r="10" fill="var(--color-lumen)" />
          <path
            d="M311.5 132.3l3 3 6-6"
            fill="none"
            stroke="var(--color-ink)"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          <rect x="0" y="240" width="176" height="80" fill="var(--color-ink)" />
          <circle
            cx="20"
            cy="260"
            r="9"
            fill="none"
            stroke="var(--color-surface)"
            strokeWidth="1.5"
          />
          <rect x="184" y="240" width="112" height="80" fill="var(--color-hairline)" />
          <rect x="196" y="300" width="88" height="4" rx="2" fill="var(--color-surface)" />
          <rect x="196" y="300" width="24" height="4" rx="2" fill="var(--color-lumen)" />
          <rect x="304" y="240" width="216" height="80" fill="var(--color-lumen-soft)" />
        </g>
      </svg>
    </div>
  );
}
