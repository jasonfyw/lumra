import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getActiveGuestSession, getAuthenticatedUser } from '@/lib/actor';
import { getClaimTarget } from '@/lib/galleries';
import { parseAuthFlowParams, type AuthFlowParams } from '@/lib/return-to';
import { isSupabaseConfigured } from '@/lib/supabase/server';
import { Icon, Wordmark, buttonClass } from '@/components/ui';
import { AuthForm } from './auth-form';
import { ClaimDraft } from './claim-draft';

export const metadata = { title: 'Sign in' };
export const dynamic = 'force-dynamic';

const ERRORS: Record<string, string> = {
  link_invalid: 'That sign-in link is invalid or has expired. Enter your email to get a new code.',
};

type SearchParams = Record<string, string | string[] | undefined>;

export default async function AuthPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const flow = parseAuthFlowParams(params);
  const errorKey = typeof params.error === 'string' ? params.error : '';

  const user = await getAuthenticatedUser();
  if (user) {
    if (flow.intent === 'publish' && flow.galleryId) {
      return <ResumePublish userId={user.userId} flow={flow} galleryId={flow.galleryId} />;
    }
    redirect(flow.returnTo);
  }

  const publishing = flow.intent === 'publish';
  return (
    <Shell title={publishing ? 'Sign in to publish' : 'Sign in'}>
      <p className="text-[var(--color-ink-muted)]">
        {publishing
          ? 'Enter your email to publish your gallery. Your photos and draft are kept.'
          : 'Enter your email and we’ll send you a sign-in code. No password needed.'}
      </p>
      {isSupabaseConfigured() ? (
        <AuthForm flow={flow} initialError={ERRORS[errorKey] ?? null} />
      ) : (
        <p role="alert" className="lm-banner lm-banner-error">
          Sign-in is not available right now. Please try again later.
        </p>
      )}
    </Shell>
  );
}

/**
 * Signed in with a pending publish intent (FR-A04): claim only if THIS browser still holds the
 * guest capability of the session that owns the draft. Opened in another browser (no cookie),
 * the user is told to return to the original one — a draft id alone never transfers ownership.
 */
async function ResumePublish({
  userId,
  flow,
  galleryId,
}: {
  userId: string;
  flow: AuthFlowParams;
  galleryId: string;
}) {
  const [target, guest] = await Promise.all([getClaimTarget(galleryId), getActiveGuestSession()]);

  if (target?.ownerId === userId && target.claimed) redirect(flow.returnTo);

  if (
    target &&
    guest &&
    target.ownerId === null &&
    target.guestSessionId === guest.guestSessionId
  ) {
    return (
      <Shell title="Finishing up">
        <ClaimDraft galleryId={galleryId} returnTo={flow.returnTo} />
      </Shell>
    );
  }

  return (
    <Shell title="You’re signed in">
      <p role="status">Return to the browser where you started to finish publishing.</p>
      <p className="text-[var(--color-ink-muted)]">
        For your security, a draft can only be moved into your account from the browser that created
        it. Open Lumra there, press Publish again and sign in with the same email.
      </p>
      <Link href="/dashboard" className={buttonClass('secondary', 'md', 'self-start')}>
        Go to your galleries
      </Link>
    </Shell>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="px-4 py-3 sm:px-8 sm:py-4">
        <Link href="/" className="-my-1 inline-flex min-h-11 items-center rounded-sm">
          <Wordmark size={28} />
        </Link>
      </header>
      <main className="flex flex-1 items-start justify-center px-4 pt-6 pb-16 sm:items-center sm:pt-0">
        <div className="lm-panel flex w-full max-w-[440px] flex-col gap-5 sm:p-8">
          <div className="lm-gate-icon size-11">
            <Icon name="mail" size={20} />
          </div>
          <h1 className="lm-title-display-sm">{title}</h1>
          {children}
        </div>
      </main>
    </div>
  );
}
