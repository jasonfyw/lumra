import type { Metadata, Viewport } from 'next';
import { Hanken_Grotesk, Instrument_Serif } from 'next/font/google';
import { COLORS } from '@lumra/ui';
import './globals.css';

/** Functional UI type (`--font-sans`). */
const sans = Hanken_Grotesk({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  display: 'swap',
  variable: '--font-hanken',
});

/** Names and moments (`--font-display`): never below 24px, never for paragraphs. */
const display = Instrument_Serif({
  subsets: ['latin'],
  weight: '400',
  style: ['normal', 'italic'],
  display: 'swap',
  variable: '--font-instrument',
});

export const metadata: Metadata = {
  title: { default: 'Lumra', template: '%s · Lumra' },
  description: 'Create, upload, publish and share photo galleries in seconds.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: COLORS.paper,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${display.variable}`}>
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
