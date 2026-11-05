import { unstable_rethrow } from 'next/navigation';
import { REQUEST_ID_HEADER, type Logger } from '@lumra/observability';
import { ApiFailure, fail, internalError, requestContext } from './api';
import { reportError } from './sentry';

export interface RouteScope {
  requestId: string;
  /** Logger bound to `requestId` and the route name. */
  log: Logger;
}

export type RouteHandler<C> = (
  request: Request,
  scope: RouteScope,
  context: C,
) => Response | Promise<Response>;

export interface WithRouteOptions {
  /** Log successful completions at debug instead of info (health probes, polling). */
  quiet?: boolean;
}

/**
 * Wraps a route handler with the cross-cutting request contract (PRD §10, §12):
 * - assigns a request ID (valid inbound `x-request-id` or a new UUID) and a bound logger;
 * - always sets `x-request-id` on the response;
 * - turns a thrown `ApiFailure` into its error envelope (expected outcome, not reported);
 * - turns unexpected throws into the standard `internal` 500 envelope — the error is logged
 *   (redacted) and sent to Sentry tagged with the request ID, but never echoed to the client;
 * - logs one completion line with method, status and duration.
 *
 * `name` is a route template such as `GET /api/v1/galleries/[id]`; raw paths are not logged
 * because they can contain share slugs or tokens.
 */
export function withRoute<C = unknown>(
  name: string,
  handler: RouteHandler<C>,
  options: WithRouteOptions = {},
) {
  return async function route(request: Request, context: C): Promise<Response> {
    const started = Date.now();
    const { requestId, log: requestLog } = requestContext(request);
    const log = requestLog.child({ route: name });

    let response: Response;
    try {
      response = await handler(request, { requestId, log }, context);
    } catch (error) {
      unstable_rethrow(error); // let notFound()/redirect() reach Next.js
      if (error instanceof ApiFailure) {
        // Expected outcome (validation, authz, quota, rate limit): not reported to Sentry.
        response = fail(error.error, requestId, {
          headers: { 'Cache-Control': 'no-store', ...error.headers },
        });
      } else {
        log.error('unhandled route error', { err: error });
        reportError(error, { requestId, route: name });
        response = internalError(requestId);
      }
    }

    response = withRequestIdHeader(response, requestId);
    const fields = {
      method: request.method,
      status: response.status,
      durationMs: Date.now() - started,
    };
    if (response.status >= 500) log.error('request failed', fields);
    else if (options.quiet) log.debug('request completed', fields);
    else log.info('request completed', fields);
    return response;
  };
}

function withRequestIdHeader(response: Response, requestId: string): Response {
  try {
    response.headers.set(REQUEST_ID_HEADER, requestId);
    return response;
  } catch {
    // Immutable headers (e.g. a proxied fetch Response): copy into a mutable response.
    const copy = new Response(response.body, response);
    copy.headers.set(REQUEST_ID_HEADER, requestId);
    return copy;
  }
}
