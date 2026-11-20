/**
 * Browser-tab title for a public gallery: `"{Gallery title} · {Owner name}"`. Falls back to the
 * gallery title alone when the owner has no name, and to the name alone when the title is blank.
 * `null` when neither exists, so callers keep their generic title. Pure; the caller decides
 * whether the viewer may see the title at all (locked galleries must not call this).
 */
export function galleryDocumentTitle(
  title: string | null | undefined,
  ownerName: string | null | undefined,
): string | null {
  const t = title?.trim() ?? '';
  const n = ownerName?.trim() ?? '';
  if (t && n) return `${t} · ${n}`;
  return t || n || null;
}
