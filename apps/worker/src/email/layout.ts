/**
 * Shared branded layout for Lumra application email (Resend, T33/T32). Plain TS strings: no
 * React, no remote fonts or images, table layout with inline styles so it renders in Gmail,
 * Outlook and Apple Mail. The visual style matches infra/supabase/templates/*.html.
 * Every dynamic value goes through `escapeHtml`.
 */

export const BRAND = {
  bg: '#faf9f7',
  card: '#ffffff',
  ink: '#1b1a18',
  muted: '#6b6860',
  line: '#e8e5df',
  lumen: '#e9b23f',
} as const;

const SERIF = "Georgia, 'Times New Roman', Times, serif";
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface EmailContent {
  /** Hidden inbox preview text. */
  preheader: string;
  heading: string;
  /** Plain-text paragraphs (escaped on render). */
  paragraphs: string[];
  /** Optional primary button. `url` must be an absolute https (or http for local dev) URL. */
  cta?: { label: string; url: string };
  /** Small print under the card, e.g. why the recipient got this email. */
  footnote?: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export function renderLayout(subject: string, c: EmailContent): RenderedEmail {
  const paragraphs = c.paragraphs
    .map(
      (p) =>
        `<p style="margin:0 0 16px;font-family:${SANS};font-size:16px;line-height:1.55;color:${BRAND.ink};">${escapeHtml(p)}</p>`,
    )
    .join('');
  const button = c.cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 8px;"><tr><td bgcolor="${BRAND.lumen}" style="border-radius:10px;background-color:${BRAND.lumen};"><a href="${escapeHtml(c.cta.url)}" style="display:inline-block;padding:14px 26px;font-family:${SANS};font-size:16px;font-weight:600;color:${BRAND.ink};text-decoration:none;border-radius:10px;">${escapeHtml(c.cta.label)}</a></td></tr></table>`
    : '';
  const footnote = c.footnote
    ? `<p style="margin:0 0 8px;font-family:${SANS};font-size:13px;line-height:1.5;color:${BRAND.muted};">${escapeHtml(c.footnote)}</p>`
    : '';
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <meta name="supported-color-schemes" content="light dark" />
    <title>${escapeHtml(subject)}</title>
  </head>
  <body style="margin:0;padding:0;background-color:${BRAND.bg};">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(c.preheader)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${BRAND.bg}" style="background-color:${BRAND.bg};">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
            <tr>
              <td style="padding:0 4px 20px;font-family:${SERIF};font-size:28px;font-weight:700;letter-spacing:-0.5px;color:${BRAND.ink};">lumra<span style="color:${BRAND.lumen};">.</span></td>
            </tr>
            <tr>
              <td bgcolor="${BRAND.card}" style="background-color:${BRAND.card};border:1px solid ${BRAND.line};border-radius:16px;padding:32px 28px;">
                <h1 style="margin:0 0 16px;font-family:${SERIF};font-size:24px;line-height:1.25;font-weight:700;color:${BRAND.ink};">${escapeHtml(c.heading)}</h1>
                ${paragraphs}
                ${button}
              </td>
            </tr>
            <tr>
              <td style="padding:20px 4px 0;">
                ${footnote}
                <p style="margin:0;font-family:${SANS};font-size:13px;line-height:1.5;color:${BRAND.muted};">Lumra &middot; lumra.photos</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
`;
  const textParts = [c.heading, '', ...c.paragraphs.flatMap((p) => [p, ''])];
  if (c.cta) textParts.push(`${c.cta.label}: ${c.cta.url}`, '');
  if (c.footnote) textParts.push(c.footnote, '');
  textParts.push('Lumra - lumra.photos');
  return { subject, html, text: textParts.join('\n') + '\n' };
}
