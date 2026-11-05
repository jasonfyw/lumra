import { UPLOAD_LIMITS } from '@lumra/config';

/** Subset of the Network Information API (`navigator.connection`, Chromium only). */
export interface ConnectionInfo {
  effectiveType?: string;
  saveData?: boolean;
  addEventListener?: (type: 'change', listener: () => void) => void;
  removeEventListener?: (type: 'change', listener: () => void) => void;
}

interface NavigatorLike {
  userAgent?: string;
  connection?: ConnectionInfo;
  userAgentData?: { mobile?: boolean };
}

/** Touch-first device: native picker, 2 concurrent files (FR-M03). */
export function detectMobile(
  nav: NavigatorLike | undefined = globalThis.navigator as NavigatorLike | undefined,
  matchMedia: ((query: string) => { matches: boolean }) | undefined = globalThis.matchMedia?.bind(
    globalThis,
  ),
): boolean {
  if (nav?.userAgentData?.mobile !== undefined) return nav.userAgentData.mobile;
  if (matchMedia?.('(pointer: coarse)').matches) return true;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(nav?.userAgent ?? '');
}

/**
 * Starting file concurrency: 3 desktop / 2 mobile (`UPLOAD_LIMITS`), reduced on connections the
 * browser reports as slow or data-saving.
 */
export function baseConcurrency(mobile: boolean, connection?: ConnectionInfo): number {
  const base = mobile ? UPLOAD_LIMITS.concurrentFilesMobile : UPLOAD_LIMITS.concurrentFilesDesktop;
  if (!connection) return base;
  if (connection.saveData) return 1;
  switch (connection.effectiveType) {
    case 'slow-2g':
    case '2g':
      return 1;
    case '3g':
      return Math.min(base, 2);
    default:
      return base;
  }
}

/**
 * Additive-increase / multiplicative-ish-decrease limit on concurrent files. Every error or slow
 * part lowers the limit by one (never below 1); a run of successes earns one slot back, up to the
 * current maximum.
 */
export class AdaptiveConcurrency {
  private successes = 0;
  limit: number;

  constructor(
    private max: number,
    private readonly recoverAfter = 4,
  ) {
    this.max = Math.max(1, max);
    this.limit = this.max;
  }

  get maximum(): number {
    return this.max;
  }

  setMax(max: number): void {
    this.max = Math.max(1, max);
    this.limit = Math.min(this.limit, this.max);
    if (this.limit < 1) this.limit = 1;
  }

  onError(): void {
    this.successes = 0;
    this.limit = Math.max(1, this.limit - 1);
  }

  onSuccess(): void {
    if (this.limit >= this.max) return;
    this.successes += 1;
    if (this.successes >= this.recoverAfter) {
      this.successes = 0;
      this.limit += 1;
    }
  }
}
