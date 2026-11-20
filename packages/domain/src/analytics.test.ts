import { describe, expect, it } from 'vitest';
import { anonymousVisitorHash, isBotUserAgent, viewWindowBucket } from './analytics';

const CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

describe('isBotUserAgent', () => {
  it('treats real browsers as humans', () => {
    expect(isBotUserAgent(CHROME)).toBe(false);
    expect(
      isBotUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Safari/604.1'),
    ).toBe(false);
  });
  it('flags crawlers, link previews, tools and empty agents', () => {
    for (const ua of [
      'Googlebot/2.1 (+http://www.google.com/bot.html)',
      'Mozilla/5.0 (compatible; bingbot/2.0)',
      'facebookexternalhit/1.1',
      'Slackbot-LinkExpanding 1.0',
      'WhatsApp/2.23',
      'curl/8.4.0',
      'python-requests/2.31',
      'HeadlessChrome/120',
      '',
      '   ',
      null,
      undefined,
    ]) {
      expect(isBotUserAgent(ua), String(ua)).toBe(true);
    }
  });
});

describe('viewWindowBucket', () => {
  it('is floor(epoch / 1800s)', () => {
    expect(viewWindowBucket(new Date(0))).toBe(0);
    expect(viewWindowBucket(new Date(1800 * 1000 - 1))).toBe(0);
    expect(viewWindowBucket(new Date(1800 * 1000))).toBe(1);
  });
});

describe('anonymousVisitorHash', () => {
  const day1 = new Date('2026-11-20T08:00:00Z');
  const gallery = '11111111-1111-4111-8111-111111111111';

  it('is stable within a day and opaque (hex, no inputs leaked)', async () => {
    const a = await anonymousVisitorHash('pepper', gallery, `v4:1.2.3.0|${CHROME}`, day1);
    const b = await anonymousVisitorHash(
      'pepper',
      gallery,
      `v4:1.2.3.0|${CHROME}`,
      new Date('2026-11-20T23:59:00Z'),
    );
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });

  it('rotates daily and differs per gallery, signal and pepper', async () => {
    const base = await anonymousVisitorHash('pepper', gallery, 'sig', day1);
    const nextDay = new Date('2026-11-21T00:00:00Z');
    expect(await anonymousVisitorHash('pepper', gallery, 'sig', nextDay)).not.toBe(base);
    expect(await anonymousVisitorHash('pepper', 'other-gallery', 'sig', day1)).not.toBe(base);
    expect(await anonymousVisitorHash('pepper', gallery, 'sig2', day1)).not.toBe(base);
    expect(await anonymousVisitorHash('pepper2', gallery, 'sig', day1)).not.toBe(base);
  });

  it('requires a pepper', async () => {
    await expect(anonymousVisitorHash('', gallery, 'sig', day1)).rejects.toThrow();
  });
});
