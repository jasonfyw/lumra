import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Supabase Auth templates (Go templates) live in infra/; guard what the app and copy rely on.
const infra = resolve(process.cwd(), '../../infra/supabase'); // vitest runs from apps/web
const config = readFileSync(resolve(infra, 'config.toml'), 'utf8');

describe.each(['magic_link', 'confirmation'])('auth template %s', (name) => {
  const html = readFileSync(resolve(infra, `templates/${name}.html`), 'utf8');

  it('shows the code and a token_hash link that /auth/confirm accepts', () => {
    expect(html).toContain('{{ .Token }}');
    expect(html).toContain(
      '{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&amp;type=email&amp;next={{ .RedirectTo }}',
    );
    // The first href must be the sign-in link (the e2e suite reads it from the email).
    expect(html.match(/href="([^"]+)"/)?.[1]).toContain('/auth/confirm?token_hash=');
  });

  it('has expiry and "didn’t request this" copy, no remote assets or scripts', () => {
    expect(html).toContain('15 minutes');
    expect(html).toContain('Didn&rsquo;t request this');
    expect(html).toContain('max-width: 560px');
    expect(html).not.toMatch(
      /<script|<link |url\(|<img |https?:\/\/[^"' ]*\.(woff2?|ttf|png|jpe?g)/i,
    );
  });

  it('is wired in config.toml with a subject carrying the code', () => {
    const table = new RegExp(
      `\\[auth\\.email\\.template\\.${name}\\]\\s+subject = "([^"]+)"\\s+content_path = "([^"]+)"`,
    ).exec(config);
    expect(table?.[1]).toBe('Your Lumra sign-in code: {{ .Token }}');
    expect(table?.[2]).toBe(`./supabase/templates/${name}.html`);
  });
});

describe('copy matches the OTP settings', () => {
  it('uses a 6-digit code that expires in 15 minutes', () => {
    expect(config).toMatch(/otp_length = 6\b/);
    expect(config).toMatch(/otp_expiry = 900\b/);
    for (const name of ['magic_link', 'confirmation']) {
      const html = readFileSync(resolve(infra, `templates/${name}.html`), 'utf8');
      expect(html).toContain('6-digit');
      expect(html).toContain('15 minutes');
    }
  });
});
