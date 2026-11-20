import { AppHeader } from '@/components/ui';

/** Temporary scaffold screen; each route replaces this in its owning task. */
export function Placeholder({ title, task }: { title: string; task: string }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader />
      <main className="mx-auto flex w-full max-w-[var(--app-max)] flex-1 flex-col justify-center gap-3 px-4 py-24 sm:px-8">
        <h1 className="lm-title-1">{title}</h1>
        <p className="text-[var(--color-ink-muted)]">Not implemented yet — tracked in {task}.</p>
      </main>
    </div>
  );
}
