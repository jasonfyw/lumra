import type { NextConfig } from 'next';
import { withSentryConfig } from '@sentry/nextjs/config';

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
];

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: [
    '@lumra/billing',
    '@lumra/config',
    '@lumra/contracts',
    '@lumra/db',
    '@lumra/domain',
    '@lumra/media',
    '@lumra/observability',
    '@lumra/ui',
  ],
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

// Source maps are uploaded (then deleted from the deploy) only when a Sentry auth token is
// present at build time — CI and local builds without Sentry env build normally.
const uploadSourceMaps = Boolean(process.env.SENTRY_AUTH_TOKEN);

export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !uploadSourceMaps,
  telemetry: false,
  widenClientFileUpload: uploadSourceMaps,
  sourcemaps: { disable: !uploadSourceMaps },
});
