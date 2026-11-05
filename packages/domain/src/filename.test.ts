import { describe, expect, it } from 'vitest';
import { sanitizeDownloadFilename } from './filename';

describe('sanitizeDownloadFilename', () => {
  it('keeps the last path segment and strips unsafe characters', () => {
    expect(sanitizeDownloadFilename('C:\\Users\\me\\IMG 1.jpg', 'photo')).toBe('IMG 1.jpg');
    expect(sanitizeDownloadFilename('../../etc/..pa"ss\u202Egpj.exe\r\n', 'photo')).toBe(
      'passgpj.exe',
    );
  });

  it('falls back when nothing safe remains', () => {
    expect(sanitizeDownloadFilename('../..', 'photo')).toBe('photo');
    expect(sanitizeDownloadFilename(undefined, 'photo')).toBe('photo');
  });

  it('bounds length by code points', () => {
    expect(Array.from(sanitizeDownloadFilename('é'.repeat(400), 'x'))).toHaveLength(150);
  });
});
