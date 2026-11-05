/** Full-page recipient notice (expired, not found, rate limited): same layout everywhere (J4). */
export function GalleryNotice({ title, body }: { title: string; body: string }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center gap-3 px-4 py-16">
      <h1 className="font-[family-name:var(--font-display)] text-2xl font-semibold tracking-tight">
        {title}
      </h1>
      <p className="text-[var(--color-ink-muted)]">{body}</p>
    </main>
  );
}
