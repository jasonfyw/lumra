import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-5xl flex-col justify-center gap-8 px-4 py-16">
      <h1 className="font-[family-name:var(--font-display)] text-5xl font-semibold tracking-tight sm:text-7xl">
        Share photos beautifully.
      </h1>
      <p className="max-w-xl text-lg text-[var(--color-ink-muted)]">
        Create a gallery, drop in your photos, and send one link. No account needed to start.
      </p>
      <div className="flex flex-wrap items-center gap-4">
        <Link
          href="/new"
          className="inline-flex min-h-11 items-center rounded-[var(--radius-control)] bg-[var(--color-accent)] px-6 font-medium text-white"
        >
          Create gallery
        </Link>
        <Link
          href="/pricing"
          className="min-h-11 content-center underline-offset-4 hover:underline"
        >
          Pricing
        </Link>
        <Link href="/auth" className="min-h-11 content-center underline-offset-4 hover:underline">
          Sign in
        </Link>
      </div>
    </main>
  );
}
