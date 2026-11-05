// Wrangler entry point. Kept separate from index.ts so unit tests (plain Node) never import
// @cloudflare/containers, which depends on the `cloudflare:workers` runtime module.
export { default } from './index';
export { ImageProcessorContainer } from './container';
