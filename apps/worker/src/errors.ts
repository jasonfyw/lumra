/**
 * Expected back-off: the queue consumer retries the message after `delaySeconds` without
 * treating it as an error (no Sentry). E.g. another delivery holds an archive build lease, or
 * the image processor is momentarily busy.
 */
export class RetryLaterError extends Error {
  constructor(
    readonly delaySeconds: number,
    reason: string,
  ) {
    super(reason);
    this.name = 'RetryLaterError';
  }
}
