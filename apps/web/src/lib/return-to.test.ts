import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RETURN_TO,
  parseAuthFlowParams,
  parseConfirmFlowParams,
  postSignInPath,
  safeReturnTo,
} from './return-to';

const GALLERY = '6f1c1a5e-1d2b-4c3a-9e8f-0a1b2c3d4e5f';

describe('safeReturnTo', () => {
  it('keeps same-origin relative paths with query and hash', () => {
    expect(safeReturnTo('/dashboard')).toBe('/dashboard');
    expect(safeReturnTo('/new?intent=publish#tiles')).toBe('/new?intent=publish#tiles');
    expect(safeReturnTo('/dashboard/galleries/abc')).toBe('/dashboard/galleries/abc');
  });

  it.each([
    undefined,
    '',
    'dashboard',
    'https://evil.example/',
    'http:evil.example',
    '//evil.example',
    '//evil.example/dashboard',
    '/\\evil.example',
    '\\\\evil.example',
    '/%0d%0aLocation:evil'.replace('%0d%0a', '\r\n'),
    'javascript:alert(1)',
    ' /dashboard',
    '/auth',
    '/auth/confirm?token_hash=x',
    '/api/v1/galleries',
    `/${'a'.repeat(600)}`,
  ])('rejects %j', (value) => {
    expect(safeReturnTo(value)).toBe(DEFAULT_RETURN_TO);
  });

  it('normalises dot segments without leaving the origin', () => {
    expect(safeReturnTo('/a/../../dashboard')).toBe('/dashboard');
    expect(safeReturnTo('/./%2F%2Fevil.example')).toBe('/%2F%2Fevil.example');
  });

  it('uses the provided fallback', () => {
    expect(safeReturnTo('https://evil.example', '/')).toBe('/');
  });
});

describe('auth flow params', () => {
  it('keeps the publish intent and a valid gallery id only', () => {
    expect(
      parseAuthFlowParams(
        new URLSearchParams({ returnTo: '/new', intent: 'publish', galleryId: GALLERY }),
      ),
    ).toEqual({ returnTo: '/new', intent: 'publish', galleryId: GALLERY });
    expect(parseAuthFlowParams({ intent: 'hack', galleryId: GALLERY })).toEqual({
      returnTo: DEFAULT_RETURN_TO,
      intent: null,
      galleryId: null,
    });
    expect(parseAuthFlowParams({ intent: 'publish', galleryId: 'nope' }).galleryId).toBeNull();
  });

  it('routes publish intents back through the claim step', () => {
    expect(postSignInPath({ returnTo: '/new', intent: 'publish', galleryId: GALLERY })).toBe(
      `/auth?returnTo=%2Fnew&intent=publish&galleryId=${GALLERY}`,
    );
    expect(postSignInPath({ returnTo: '/new', intent: null, galleryId: null })).toBe('/new');
  });

  it('unwraps a same-origin `next` from the email template and ignores foreign ones', () => {
    const origin = 'https://lumra.test';
    const next = `${origin}/auth/confirm?returnTo=%2Fnew&intent=publish&galleryId=${GALLERY}`;
    expect(parseConfirmFlowParams(new URLSearchParams({ next }), origin)).toEqual({
      returnTo: '/new',
      intent: 'publish',
      galleryId: GALLERY,
    });
    expect(
      parseConfirmFlowParams(new URLSearchParams({ next: `${origin}/dashboard?x=1` }), origin),
    ).toEqual({ returnTo: '/dashboard?x=1', intent: null, galleryId: null });
    expect(
      parseConfirmFlowParams(
        new URLSearchParams({ next: 'https://evil.example/steal', returnTo: '/new' }),
        origin,
      ).returnTo,
    ).toBe('/new');
    expect(
      parseConfirmFlowParams(new URLSearchParams({ next: 'https://evil.example/' }), origin)
        .returnTo,
    ).toBe(DEFAULT_RETURN_TO);
  });
});
