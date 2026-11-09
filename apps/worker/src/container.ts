import { Container } from '@cloudflare/containers';
import { PROCESSOR_LIMITS } from '@lumra/config';

/**
 * Cloudflare Containers Durable Object fronting the image-processor image (ADR-002).
 * Each DO instance owns one container; `services.ts` spreads jobs over a small fixed pool of
 * named instances. Instances sleep after 15 idle minutes (warm across bursts of uploads), so
 * cost still scales to zero.
 *
 * The container gets no internet access: it only receives bytes from, and returns bytes to,
 * this Worker. It holds no credentials (R2 and Postgres stay in the Worker).
 */
export class ImageProcessorContainer extends Container {
  override defaultPort = 8080;
  override sleepAfter = '15m';
  override enableInternet = false;
  override pingEndpoint = 'healthz';
  override envVars = {
    PORT: '8080',
    LOG_LEVEL: 'info',
    VIPS_CONCURRENCY: String(PROCESSOR_LIMITS.vipsConcurrency),
  };
}
