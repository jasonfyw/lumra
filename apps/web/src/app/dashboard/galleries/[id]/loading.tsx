import { AppHeader } from '@/components/ui';

/**
 * Shown the instant the editor route is requested (e.g. right after "New gallery"), while the
 * server authenticates and loads the gallery. Mirrors the editor's layout so nothing jumps.
 */
export default function Loading() {
  return (
    <div className="flex min-h-dvh flex-col" aria-busy="true">
      <AppHeader back={{ href: '/dashboard', label: 'Galleries' }} />
      <div className="grid w-full flex-1 lg:grid-cols-[minmax(0,1fr)_var(--panel-width)]">
        <main className="order-2 flex min-w-0 flex-col gap-6 px-4 py-6 sm:px-8 sm:py-8 lg:order-none">
          <div className="lm-shimmer h-10 w-2/3 max-w-md rounded-[var(--radius-sm)]" />
          <div className="lm-shimmer h-28 w-full rounded-[var(--radius-md)]" />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="lm-shimmer aspect-square rounded-[var(--radius-sm)]" />
            ))}
          </div>
        </main>
        <aside
          aria-hidden="true"
          className="order-1 hidden border-[var(--color-hairline)] bg-[var(--color-surface)] px-6 py-8 lg:order-none lg:block lg:border-l"
        />
      </div>
      <p role="status" className="sr-only">
        Loading gallery…
      </p>
    </div>
  );
}
