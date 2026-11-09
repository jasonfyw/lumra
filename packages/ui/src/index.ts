/**
 * Lumra design system: token values for TS consumers and the icon set. Styles live in
 * `tokens.css` (Tailwind `@theme`) and `components.css` (`lm-` component classes).
 */
export const MIN_TOUCH_TARGET_PX = 44;

/** Colour tokens (mirror of tokens.css, for places CSS can't reach: meta theme-color, canvas). */
export const COLORS = {
  paper: '#faf9f7',
  surface: '#ffffff',
  sunken: '#f2f0ec',
  hairline: '#e6e3dd',
  border: '#8f8a81',
  ink: '#1b1a18',
  inkMuted: '#5e5a53',
  inkHover: '#34322e',
  lumen: '#f0b43c',
  lumenSoft: '#fcefd2',
  lumenInk: '#7a4e00',
  success: '#1e6b47',
  successSoft: '#e3f1e8',
  danger: '#b3261e',
  dangerSoft: '#fbe9e7',
  night: '#0f0e0d',
  nightRaised: '#262422',
  onNight: '#f4f2ee',
  onNightMuted: '#a8a39a',
} as const;

/** Motion tokens in ms (PRD §4: 180–320 ms microinteractions). */
export const DURATION_MS = { fast: 180, base: 240, slow: 320 } as const;

/**
 * Lumra's own 24px line icon set: 1.75 stroke, round caps and joins, `currentColor`.
 * Dotted glyphs (`more`, `grip`) render with a 3px stroke so the dots read.
 */
export const ICON_PATHS = {
  upload: 'M12 15V4M7.5 8.5L12 4l4.5 4.5M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4',
  download: 'M12 4v11M7.5 10.5L12 15l4.5-4.5M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4',
  link: 'M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  qr: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 18h2v2h-2zM14 19h1M19 14h1',
  share: 'M12 3v12M8 7l4-4 4 4M7 11H5v10h14V11h-2',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  x: 'M6 6l12 12M18 6L6 18',
  'chevron-left': 'M15 5l-7 7 7 7',
  'chevron-right': 'M9 5l7 7-7 7',
  'chevron-down': 'M5 9l7 7 7-7',
  lock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3.5 2',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  grip: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 2-2 5 5M15.5 9h.01',
  eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z',
  plus: 'M12 5v14M5 12h14',
  'arrow-left': 'M19 12H5M11 6l-6 6 6 6',
  alert: 'M12 3.5l9 16H3zM12 10v4M12 17h.01',
  refresh: 'M20 11a8 8 0 1 0-2.34 5.66M20 4v7h-7',
  calendar: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
  star: 'M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z',
  select: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM8 12.5l2.8 2.8L16 10',
  mail: 'M3.5 6h17v12h-17zM4 7l8 6 8-7',
} as const;

export type IconName = keyof typeof ICON_PATHS;

/** Glyphs drawn as dots, which need a heavier stroke to read. */
export const DOTTED_ICONS: ReadonlySet<IconName> = new Set<IconName>(['more', 'grip']);
