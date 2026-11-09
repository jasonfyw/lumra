import Link from 'next/link';
import { Wordmark } from '@/components/ui';

/** Discreet "Made with Lumra" pill for galleries with `brandingVisible` (Free plan, T17). */
export function LumraBadge() {
  return (
    <Link href="/" className="lm-badge">
      Made with <Wordmark size={16} />
    </Link>
  );
}
