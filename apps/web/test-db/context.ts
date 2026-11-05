/** Per-test fake request context, shared by the mocks (mocks.ts) and the tests (setup.ts). */
export interface TestRequestContext {
  user: null | { id: string; email: string };
  cookies: Map<string, string>;
}

const globalKey = '__lumraTestRequestContext';
const store = globalThis as unknown as Record<string, TestRequestContext | undefined>;

export const ctx: TestRequestContext = (store[globalKey] ??= { user: null, cookies: new Map() });
