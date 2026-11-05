import 'server-only';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { cookies } from 'next/headers';
import { guestSessions } from '@lumra/db';
import { getDb } from './db';
import { serverEnv } from './env';
import { GUEST_COOKIE_NAME, hashGuestCapability, isWellFormedCapability } from './guest-capability';
import { createSupabaseServerClient } from './supabase/server';

export interface AuthenticatedUser {
  userId: string;
  email: string | null;
}

export interface ActiveGuestSession {
  guestSessionId: string;
  expiresAt: Date;
}

/** Who is making the request. Authorization decisions start here (PRD §6.2 access matrix). */
export type Actor =
  | ({ kind: 'user' } & AuthenticatedUser)
  | ({ kind: 'guest' } & ActiveGuestSession)
  | { kind: 'anonymous' };

/** Verified Supabase user (server-side `getUser`, never the unverified session cookie). */
export async function getAuthenticatedUser(): Promise<AuthenticatedUser | null> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return { userId: data.user.id, email: data.user.email ?? null };
}

/** The guest draft session proven by the capability cookie, if unexpired and unclaimed. */
export async function getActiveGuestSession(now = new Date()): Promise<ActiveGuestSession | null> {
  const pepper = serverEnv().GUEST_CAPABILITY_PEPPER;
  if (!pepper) return null;
  const capability = (await cookies()).get(GUEST_COOKIE_NAME)?.value;
  if (!isWellFormedCapability(capability)) return null;

  const capabilityHash = await hashGuestCapability(capability, pepper);
  const [row] = await getDb()
    .select({ id: guestSessions.id, expiresAt: guestSessions.expiresAt })
    .from(guestSessions)
    .where(
      and(
        eq(guestSessions.capabilityHash, capabilityHash),
        gt(guestSessions.expiresAt, now),
        // Either column marks a claim (ADR-005); match reserve_guest_upload's `claimed_at is null`.
        isNull(guestSessions.claimedByUserId),
        isNull(guestSessions.claimedAt),
      ),
    )
    .limit(1);
  return row ? { guestSessionId: row.id, expiresAt: row.expiresAt } : null;
}

/**
 * Every credential the request carries. Upload endpoints authorise against the resource's owner:
 * a signed-in user who still holds the guest cookie (J1, before the claim) can keep working on
 * the guest draft, and the guest capability never grants access to account-owned galleries.
 */
export interface Principals {
  user: AuthenticatedUser | null;
  guest: ActiveGuestSession | null;
}

export async function getPrincipals(): Promise<Principals> {
  const [user, guest] = await Promise.all([getAuthenticatedUser(), getActiveGuestSession()]);
  return { user, guest };
}

/** A signed-in user takes precedence; the guest capability is still readable for claims (T07). */
export async function getActor(): Promise<Actor> {
  const user = await getAuthenticatedUser();
  if (user) return { kind: 'user', ...user };
  const guest = await getActiveGuestSession();
  if (guest) return { kind: 'guest', ...guest };
  return { kind: 'anonymous' };
}
