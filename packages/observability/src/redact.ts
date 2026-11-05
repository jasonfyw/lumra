/**
 * Redaction for logs and error reports (PRD §6.2 Privacy, §12 Observability).
 *
 * Two layers:
 *  1. Key-based: values under sensitive keys (token, secret, password, authorization, cookie,
 *     signature, key, email, ip, …) are replaced wholesale. IP-like keys keep a truncated
 *     prefix (/24 for IPv4, /48 for IPv6) when the value is an address, otherwise are dropped.
 *  2. Value-based: every string is scanned for JWTs, bearer credentials, provider secrets,
 *     signed-URL query params (X-Amz-Signature, X-Amz-Credential, token, code, …), URL
 *     userinfo, email addresses and IP addresses — so secrets are caught even in free text.
 *
 * Web APIs only: safe on Cloudflare Workers, the Next.js Edge runtime and Node.
 */

export const REDACTED = '[REDACTED]';
export const REDACTED_JWT = '[REDACTED_JWT]';
export const REDACTED_EMAIL = '[REDACTED_EMAIL]';

/**
 * Words that mark a key as sensitive. A key is split into words (camelCase, snake_case,
 * kebab-case); it is sensitive when a word equals one of these, or — for entries of five
 * or more characters — contains one (so `accesstoken`, `passwordHash` also match).
 */
export const DEFAULT_SENSITIVE_KEY_WORDS: readonly string[] = [
  'token',
  'secret',
  'password',
  'passwd',
  'pwd',
  'passphrase',
  'authorization',
  'cookie',
  'signature',
  'sig',
  'key',
  'apikey',
  'email',
  'credential',
  'jwt',
  'dsn',
  'pepper',
  'bearer',
];

/** Keys that hold IP addresses. Values are truncated to a network prefix, never logged in full. */
const IP_KEY_WORDS = new Set(['ip', 'ipv4', 'ipv6', 'ipaddr', 'ipaddress']);
const IP_KEY_NAMES = new Set([
  'remoteaddr',
  'remoteaddress',
  'clientaddress',
  'xforwardedfor',
  'forwardedfor',
  'xrealip',
  'cfconnectingip',
  'trueclientip',
]);

/** Keys whose names look sensitive but whose values are known-safe identifiers. */
export const DEFAULT_ALLOW_KEYS: readonly string[] = ['dedupeKey'];

export interface RedactOptions {
  /** Replaces the default sensitive key words entirely. */
  keyWords?: readonly string[];
  /** Added to the (default or replaced) sensitive key words. */
  extraKeyWords?: readonly string[];
  /** Exact key names that are never redacted by key (values are still pattern-scanned). */
  allowKeys?: readonly string[];
  maxDepth?: number;
  maxStringLength?: number;
  maxArrayLength?: number;
}

export interface Redactor {
  /** Deep-copies `value` into a JSON-safe structure with sensitive data removed. */
  redact(value: unknown): unknown;
  /** Applies the value patterns to a single string. */
  redactString(value: string): string;
  isSensitiveKey(key: string): boolean;
}

// --- value patterns -------------------------------------------------------------------------

const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi;
// `name=value` in a query string / fragment / form body. Name sensitivity is decided below.
const PARAM = /(^|[?&;#\s])([A-Za-z0-9_.[\]-]+)=([^&#\s"'<>]*)/g;
const SENSITIVE_PARAM_NAMES = new Set([
  'code', // OAuth / Supabase auth callback codes
  'state',
  'expires',
  'policy',
  'key-pair-id',
  'googleaccessid',
  'awsaccesskeyid',
]);
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
const AUTH_SCHEME = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{6,}/gi;
const PROVIDER_SECRET = /\b(?:(?:sk|rk)_(?:live|test)_|whsec_|sbp_)[A-Za-z0-9+/=_-]{8,}/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4 = new RegExp(
  `(?<!\\d|\\d\\.)(${OCTET}\\.${OCTET}\\.${OCTET})\\.${OCTET}(?!\\d|\\.\\d|/24\\b)`,
  'g',
);
const IPV6_CANDIDATE =
  /(?<![0-9A-Za-z:.])(?:[0-9A-Fa-f]{0,4}:){2,7}(?:(?:\d{1,3}\.){3}\d{1,3}|[0-9A-Fa-f]{1,4})?(?![0-9A-Za-z:]|\.\d|\/48)/g;

/** Truncates a valid IPv6 address to its /48 prefix; returns null when `candidate` is not one. */
function truncateIpv6(candidate: string): string | null {
  let s = candidate;
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (v4?.[1]) s = `${s.slice(0, -v4[1].length)}0:0`;
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const groups = (part: string | undefined) => (part ? part.split(':') : []);
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  const all = [...head, ...tail];
  if (all.length === 0 || all.some((g) => !/^[0-9A-Fa-f]{1,4}$/.test(g))) return null;
  if (halves.length === 1 ? all.length !== 8 : all.length > 7) return null;
  const full = [...head, ...Array<string>(8 - all.length).fill('0'), ...tail];
  return `${full
    .slice(0, 3)
    .map((g) => parseInt(g, 16).toString(16))
    .join(':')}::/48`;
}

function isIpKey(key: string, words: string[]): boolean {
  if (words.some((w) => IP_KEY_WORDS.has(w))) return true;
  return IP_KEY_NAMES.has(key.toLowerCase().replace(/[^a-z0-9]/g, ''));
}

function splitWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function createRedactor(options: RedactOptions = {}): Redactor {
  const keyWords = [
    ...(options.keyWords ?? DEFAULT_SENSITIVE_KEY_WORDS),
    ...(options.extraKeyWords ?? []),
  ]
    .map((w) => w.toLowerCase().replace(/[^a-z0-9]/g, ''))
    .filter(Boolean);
  const exactWords = new Set(keyWords);
  const containsWords = keyWords.filter((w) => w.length >= 5);
  const allowKeys = new Set(options.allowKeys ?? DEFAULT_ALLOW_KEYS);
  const maxDepth = options.maxDepth ?? 8;
  const maxStringLength = options.maxStringLength ?? 2048;
  const maxArrayLength = options.maxArrayLength ?? 100;

  function wordsSensitive(words: string[]): boolean {
    return words.some((w) => exactWords.has(w) || containsWords.some((c) => w.includes(c)));
  }

  function isSensitiveKey(key: string): boolean {
    if (allowKeys.has(key)) return false;
    const words = splitWords(key);
    // Also test the whole key collapsed, so `api_key`/`x-api-key` hit `apikey`.
    return wordsSensitive(words) || wordsSensitive([words.join('')]);
  }

  function isSensitiveParam(name: string): boolean {
    const lower = name.toLowerCase();
    if (lower.startsWith('x-amz-') || lower.startsWith('x-goog-')) return true;
    return SENSITIVE_PARAM_NAMES.has(lower) || isSensitiveKey(name);
  }

  function redactString(input: string): string {
    let s = input
      .replace(URL_USERINFO, `$1${REDACTED}@`)
      .replace(PARAM, (match, sep: string, name: string, value: string) =>
        value && value !== REDACTED && isSensitiveParam(name) ? `${sep}${name}=${REDACTED}` : match,
      )
      .replace(JWT, REDACTED_JWT)
      .replace(AUTH_SCHEME, `$1 ${REDACTED}`)
      .replace(PROVIDER_SECRET, REDACTED)
      .replace(EMAIL, REDACTED_EMAIL)
      .replace(IPV6_CANDIDATE, (match) => truncateIpv6(match) ?? match)
      .replace(IPV4, '$1.0/24');
    if (s.length > maxStringLength) s = `${s.slice(0, maxStringLength)}…[truncated]`;
    return s;
  }

  function redactIpValue(value: unknown): unknown {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') {
      const truncated = redactString(value);
      return truncated !== value ? truncated : REDACTED;
    }
    if (Array.isArray(value)) return value.slice(0, maxArrayLength).map(redactIpValue);
    return REDACTED;
  }

  function walk(value: unknown, depth: number, seen: WeakSet<object>): unknown {
    switch (typeof value) {
      case 'string':
        return redactString(value);
      case 'number':
        return Number.isFinite(value) ? value : String(value);
      case 'boolean':
      case 'undefined':
        return value;
      case 'bigint':
        return value.toString();
      case 'symbol':
      case 'function':
        return undefined;
    }
    if (value === null) return null;
    const obj = value as object;

    if (obj instanceof Date)
      return Number.isNaN(obj.getTime()) ? 'Invalid Date' : obj.toISOString();
    if (obj instanceof URL) return redactString(obj.href);
    if (obj instanceof Error) {
      // Minimal shape; stacks are only added by `serializeError` when explicitly allowed.
      const code = (obj as { code?: unknown }).code;
      return {
        name: obj.name,
        message: redactString(obj.message),
        ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}),
      };
    }
    if (depth >= maxDepth) return '[Truncated]';
    if (seen.has(obj)) return '[Circular]';
    seen.add(obj);
    try {
      if (Array.isArray(obj)) {
        const out = obj.slice(0, maxArrayLength).map((v) => walk(v, depth + 1, seen));
        if (obj.length > maxArrayLength) out.push(`[${obj.length - maxArrayLength} more]`);
        return out;
      }
      let source: object = obj;
      if (typeof Headers !== 'undefined' && obj instanceof Headers) {
        source = Object.fromEntries(obj.entries());
      } else if (obj instanceof Map) {
        source = Object.fromEntries(obj.entries());
      } else if (typeof (obj as { toJSON?: unknown }).toJSON === 'function') {
        return walk((obj as { toJSON: () => unknown }).toJSON(), depth, seen);
      }
      const out: Record<string, unknown> = {};
      for (const [key, v] of Object.entries(source)) {
        if (allowKeys.has(key)) out[key] = walk(v, depth + 1, seen);
        else if (isIpKey(key, splitWords(key))) out[key] = redactIpValue(v);
        else if (isSensitiveKey(key))
          out[key] = v === null || v === undefined || v === '' ? v : REDACTED;
        else out[key] = walk(v, depth + 1, seen);
      }
      return out;
    } finally {
      seen.delete(obj);
    }
  }

  return {
    redact: (value) => walk(value, 0, new WeakSet()),
    redactString,
    isSensitiveKey,
  };
}

export const defaultRedactor: Redactor = createRedactor();

/** Deep-redacts `value` with the default policy. */
export function redact(value: unknown): unknown {
  return defaultRedactor.redact(value);
}

/** Applies the default value patterns (JWT, signed URL params, email, IP, …) to a string. */
export function redactString(value: string): string {
  return defaultRedactor.redactString(value);
}
