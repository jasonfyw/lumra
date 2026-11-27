import { describe, expect, it } from 'vitest';
import { galleryDocumentTitle } from './gallery-title';

describe('galleryDocumentTitle', () => {
  it('joins gallery title and owner name', () => {
    expect(galleryDocumentTitle('Summer trip', 'Ada Lovelace')).toBe('Summer trip · Ada Lovelace');
  });
  it('keeps the plain title when the owner has no name', () => {
    expect(galleryDocumentTitle('Summer trip', null)).toBe('Summer trip');
    expect(galleryDocumentTitle('Summer trip', undefined)).toBe('Summer trip');
    expect(galleryDocumentTitle('Summer trip', '   ')).toBe('Summer trip');
  });
  it('trims both parts', () => {
    expect(galleryDocumentTitle('  Trip ', ' Ada ')).toBe('Trip · Ada');
  });
  it('falls back to the name, then to null', () => {
    expect(galleryDocumentTitle('', 'Ada')).toBe('Ada');
    expect(galleryDocumentTitle('  ', null)).toBeNull();
    expect(galleryDocumentTitle(null, undefined)).toBeNull();
  });
});
