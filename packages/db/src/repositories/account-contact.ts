/**
 * SERVER-ONLY. Looks up where to send an account's email (`email.send`, T33/T32). The outbox and
 * queue carry only the account id, so the address is read at send time and never stored in them.
 */
import type postgres from 'postgres';

export interface AccountContactRepository {
  /** The account's email address, or null when the profile is missing or has no address. */
  emailFor(accountId: string): Promise<string | null>;
}

export function createAccountContactRepository(sql: postgres.Sql): AccountContactRepository {
  return {
    async emailFor(accountId) {
      const rows = await sql<{ email: string | null }[]>`
        select email from public.profiles where user_id = ${accountId}::uuid`;
      const email = rows[0]?.email?.trim();
      return email ? email : null;
    },
  };
}
