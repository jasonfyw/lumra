import { render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { localInputToUtcIso, utcIsoToLocalInput } from '@/lib/editor-client';
import { LocalTime } from './local-time';

const originalTz = process.env.TZ;
afterEach(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

describe('LocalTime', () => {
  it('renders the viewer-local date with the full ISO in dateTime and an absolute title', () => {
    process.env.TZ = 'America/Toronto';
    // 02:30 UTC on Nov 5 is still the evening of Nov 4 in Toronto (EST, UTC-5).
    render(<LocalTime value="2026-11-05T02:30:00.000Z" />);
    const el = screen.getByText('Nov 4, 2026');
    expect(el.tagName).toBe('TIME');
    expect(el.getAttribute('dateTime')).toBe('2026-11-05T02:30:00.000Z');
    expect(el.getAttribute('title')).toMatch(/9:30\s?PM/);
  });

  it('renders date and time for format="datetime"', () => {
    process.env.TZ = 'America/Toronto';
    render(<LocalTime value="2026-07-01T16:05:00.000Z" format="datetime" />);
    expect(screen.getByText(/Jul 1, 2026.*12:05\s?PM/)).toBeTruthy();
  });

  it('server-renders a stable UTC fallback', () => {
    process.env.TZ = 'America/Toronto';
    const html = renderToString(<LocalTime value="2026-11-05T02:30:00.000Z" format="datetime" />);
    expect(html).toContain('Nov 5, 2026');
    expect(html).toContain('UTC');
    expect(html).toContain('dateTime="2026-11-05T02:30:00.000Z"');
  });
});

describe('expiry input conversion across zones', () => {
  it.each(['America/Toronto', 'Pacific/Auckland', 'UTC', 'Asia/Kolkata'])(
    'round-trips late-evening and early-morning values without moving the day (%s)',
    (tz) => {
      process.env.TZ = tz;
      for (const local of ['2030-03-09T23:30', '2030-03-10T00:15', '2030-12-31T23:59']) {
        const iso = localInputToUtcIso(local)!;
        expect(utcIsoToLocalInput(iso)).toBe(local);
      }
    },
  );

  it('saves local wall time as the matching UTC instant', () => {
    process.env.TZ = 'America/Toronto';
    expect(localInputToUtcIso('2030-01-02T21:00')).toBe('2030-01-03T02:00:00.000Z'); // EST
    expect(localInputToUtcIso('2030-07-02T21:00')).toBe('2030-07-03T01:00:00.000Z'); // EDT
    expect(utcIsoToLocalInput('2030-01-03T02:00:00.000Z')).toBe('2030-01-02T21:00');
  });
});
