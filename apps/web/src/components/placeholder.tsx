/** Temporary scaffold screen; each route replaces this in its owning task. */
export function Placeholder({ title, task }: { title: string; task: string }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col justify-center gap-3 px-4 py-16">
      <h1 className="font-[family-name:var(--font-display)] text-3xl font-semibold tracking-tight">
        {title}
      </h1>
      <p className="text-[var(--color-ink-muted)]">Not implemented yet — tracked in {task}.</p>
    </main>
  );
}
