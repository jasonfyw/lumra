import type { Metadata, Viewport } from 'next';
import { Hanken_Grotesk } from 'next/font/google';
import { COLORS } from '@lumra/ui';
import './globals.css';

/** Functional UI type (`--font-sans`). */
const sans = Hanken_Grotesk({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  display: 'swap',
  variable: '--font-hanken',
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
    <html lang="en" className={sans.variable}>
      <head>
        {/* Display type: Adobe Fonts kit (Warbler Banner as `warbler-banner`), see --font-display. */}
        <link rel="preconnect" href="https://use.typekit.net" crossOrigin="anonymous" />
        <link rel="preconnect" href="https://p.typekit.net" crossOrigin="anonymous" />
        <link rel="stylesheet" href="https://use.typekit.net/bcq1ofs.css" />
      </head>
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
