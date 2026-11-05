import type { TestRequestState } from './setup';

/**
 * The per-test fake request (signed-in user + cookie jar) owned by setup.ts (the vitest setup
 * file). Re-exported for the T05/T07/T08 fixtures; setup.ts clears it after every test.
 */
export const ctx: TestRequestState = (
  globalThis as unknown as { __lumraTestState: TestRequestState }
).__lumraTestState;
