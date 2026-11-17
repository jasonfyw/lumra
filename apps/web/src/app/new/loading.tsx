import { AppHeader } from '@/components/ui';

/** Instant shell for `/new` while the server resolves who is signed in. */
export default function Loading() {
  return (
    <div className="flex min-h-dvh flex-col" aria-busy="true">
      <AppHeader />
      <main className="mx-auto flex w-full max-w-[880px] flex-1 flex-col gap-6 px-4 pt-6 pb-8 sm:px-8 sm:pt-10">
        <div className="lm-title-1" aria-hidden="true">
          New gallery
        </div>
        <div className="lm-shimmer h-11 w-full rounded-[var(--radius-sm)]" />
        <div className="lm-shimmer h-44 w-full rounded-[var(--radius-md)]" />
        <p role="status" className="sr-only">
          Loading…
        </p>
      </main>
    </div>
  );
}
