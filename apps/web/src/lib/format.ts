/** Display helpers. Bytes use decimal units (1 GB = 1,000,000,000 bytes), matching billing. */
const UNITS = ['bytes', 'KB', 'MB', 'GB', 'TB'] as const;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 bytes';
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  if (unit === 0) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  const text = value.toFixed(digits);
  return `${digits > 0 ? text.replace(/\.?0+$/, '') : text} ${UNITS[unit]}`;
}

const dateFormat = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

/** Server-rendered dates are shown in UTC to avoid hydration drift (labelled in the UI). */
export function formatDate(iso: string): string {
  return dateFormat.format(new Date(iso));
}

const gbFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

/**
 * Bytes as decimal GB (1 GB = 1,000,000,000 bytes) for usage summaries: at most two decimals,
 * and "< 0.01 GB" for small non-zero amounts so stored photos never read as zero.
 */
export function formatGigabytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 GB';
  const hundredths = Math.round(bytes / 10_000_000);
  if (hundredths === 0) return '< 0.01 GB';
  return `${gbFormat.format(hundredths / 100)} GB`;
}

const usdFormat = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const usdRateFormat = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

/**
 * Integer micro-USD as dollars and cents for display ("$4.20"). Rounds half up to whole cents
 * in integer arithmetic first; the float only ever holds an exact cent count for formatting.
 */
export function formatUsd(microUsd: number): string {
  if (!Number.isSafeInteger(microUsd)) return usdFormat.format(0);
  const sign = microUsd < 0 ? -1 : 1;
  const cents = Math.floor((Math.abs(microUsd) * 2 + 10_000) / 20_000);
  return usdFormat.format((sign * cents) / 100);
}

/** A unit price in micro-USD with up to four decimals ("$0.10", "$0.03", "$0.0025"). */
export function formatUsdRate(microUsd: number): string {
  if (!Number.isSafeInteger(microUsd)) return usdRateFormat.format(0);
  return usdRateFormat.format(Math.round(microUsd / 100) / 10_000);
}
