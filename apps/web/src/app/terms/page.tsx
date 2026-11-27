import Link from 'next/link';
import { RATE_CARD } from '@lumra/config';
import { AppHeader, buttonClass } from '@/components/ui';
import { formatUsd, formatUsdRate } from '@/lib/format';

export const metadata = { title: 'Terms and Conditions' };

const LAST_UPDATED = '2026-11-27';
// TODO(owner): replace with the registered legal entity name, address and monitored contact email.
const CONTACT_EMAIL = 'legal@<domain>';
const CONTACT_ADDRESS = '[Registered business address to be confirmed], Ontario, Canada';

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h2 id={id} className="text-xl font-semibold">
        {title}
      </h2>
      <div className="flex flex-col gap-3 text-[var(--color-ink-muted)]">{children}</div>
    </section>
  );
}

export default function TermsPage() {
  const { free, pro } = RATE_CARD;
  const monthly = formatUsd(pro.monthlyFeeMicroUsd);
  const overage = formatUsdRate(pro.storageOverageMicroUsdPerGbMonth ?? 0);
  const freeGb = Math.round((free.maxStorageBytes ?? 0) / 1_000_000_000);
  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader
        actions={
          <Link href="/pricing" className={buttonClass('ghost')}>
            Pricing
          </Link>
        }
      />
      <main className="mx-auto flex w-full max-w-[var(--app-max)] flex-col gap-8 px-4 py-8 sm:px-8 sm:py-12">
        <header className="flex max-w-2xl flex-col gap-3">
          <h1 className="lm-title-1">Terms and Conditions</h1>
          <p className="lm-body-lg text-[var(--color-ink-muted)]">
            Last updated: <time dateTime={LAST_UPDATED}>{LAST_UPDATED}</time>
          </p>
        </header>

        <div className="flex max-w-2xl flex-col gap-8">
          <Section id="acceptance" title="1. Acceptance of these terms">
            <p>
              These terms govern your use of Lumra, a service for uploading photos, publishing
              galleries and sharing them by link (the &ldquo;Service&rdquo;). By using the Service,
              whether as a creator, a gallery visitor or an anonymous uploader, you agree to these
              terms. If you do not agree, please do not use the Service.
            </p>
          </Section>

          <Section id="eligibility" title="2. Eligibility">
            <p>
              You must be old enough to form a binding contract where you live, and in any case at
              least 16 years old. If you use Lumra on behalf of a business, you confirm you have
              authority to bind it. You must not use the Service if you have previously been removed
              from it for breaching these terms.
            </p>
          </Section>

          <Section id="accounts" title="3. Accounts">
            <p>
              You sign in with your email address using a one-time link or code. Provide accurate
              information, keep access to your email secure, and tell us promptly if you suspect
              unauthorized use. You are responsible for activity under your account. Gallery
              passwords and share links are your responsibility: anyone who has a link (and
              password, if set) can view that gallery.
            </p>
          </Section>

          <Section id="content" title="4. Your content and our licence to host it">
            <p>
              You keep ownership of everything you upload (&ldquo;Content&rdquo;). You grant Lumra a
              worldwide, non-exclusive, royalty-free licence to store, copy, process (for example,
              to create resized previews and ZIP archives), transmit and display your Content, only
              as needed to operate the Service and to show it to the people you share it with. This
              licence ends when your Content is deleted, subject to a short period for backups and
              cleanup. We do not sell your Content or use it for advertising.
            </p>
            <p>
              You confirm that you own your Content or have all rights, consents and releases needed
              to upload and share it, including from people who appear in it.
            </p>
          </Section>

          <Section id="acceptable-use" title="5. Acceptable use">
            <p>You must not use Lumra to upload, share or link to:</p>
            <ul className="list-disc space-y-1 pl-6">
              <li>
                child sexual abuse material or any sexualized content involving minors; we remove it
                immediately, close the account, and report it to the authorities as required by law;
              </li>
              <li>
                content that is unlawful, defamatory, harassing, or that shows non-consensual
                intimate imagery;
              </li>
              <li>
                content that infringes copyright, trademark, privacy or other rights of others;
              </li>
              <li>
                malware, or anything intended to disrupt or gain unauthorized access to systems.
              </li>
            </ul>
            <p>
              You also must not scrape the Service, evade rate limits or quotas, probe for storage
              keys or other people&rsquo;s galleries, or use the Service as general-purpose file
              hosting. Lumra does not currently support video. If you believe content on Lumra
              infringes your rights, email us at the address below with the gallery link and
              details, and we will review it promptly.
            </p>
          </Section>

          <Section id="anonymous" title="6. Anonymous and demo uploads">
            <p>
              You can start a draft without an account. Anonymous drafts are limited to 20 files or
              250&nbsp;MB in total, are tied to the browser that created them, and expire 24 hours
              after creation. Expired drafts and their files are deleted and cannot be recovered. To
              keep a gallery, sign in and publish before the draft expires. Anonymous drafts are
              subject to these terms, including acceptable use, and may be rate limited or removed
              at any time.
            </p>
          </Section>

          <Section id="payments" title="7. Payments, billing and refunds">
            <p>
              The Free plan costs nothing and includes up to {free.maxActiveGalleries} active
              galleries and {freeGb}&nbsp;GB of storage, with Lumra branding shown. Pro costs{' '}
              {monthly} per month and includes {pro.includedStorageGbMonth}&nbsp;GB-months of
              storage; storage beyond that is billed at {overage}. Storage is measured in decimal
              gigabytes over time. Viewing and downloading galleries is not metered or charged.
              Current prices are always shown on our{' '}
              <Link href="/pricing" className="underline">
                pricing page
              </Link>
              , and amounts are in US dollars unless stated otherwise. Applicable taxes may be
              added.
            </p>
            <p>
              Payments are processed by Stripe. Pro renews monthly until cancelled, and you can
              cancel at any time from your account; cancellation takes effect at the end of the
              current billing period. You can set a monthly spending cap, and once it is reached we
              stop new uploads rather than charge you more. If a payment fails, we pause new
              uploads, give you notice and a grace period before public delivery is suspended, and
              we do not delete your files solely because a payment failed without warning.
            </p>
            <p>
              Fees already charged are non-refundable, including for partial months, except where
              the law requires otherwise or where we have billed you in error, in which case we will
              correct it. If you think you were charged incorrectly, contact us within 60 days. We
              may change prices on prior notice; changes apply from your next billing period.
            </p>
          </Section>

          <Section id="termination" title="8. Termination">
            <p>
              You can stop using Lumra and delete your galleries or account at any time. Deleting a
              gallery makes it inaccessible immediately, and the stored files are then permanently
              removed in the background. We may suspend or terminate access, with notice where
              practical, if you breach these terms, put the Service or others at risk, or fail to
              pay. We may remove content immediately where needed to comply with law or to prevent
              harm. Sections that by their nature should survive termination (including 4, 9, 10, 12
              and 13) will continue to apply.
            </p>
          </Section>

          <Section id="disclaimers" title="9. Disclaimers">
            <p>
              The Service is provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo;. To the
              extent permitted by law, we disclaim all warranties, express or implied, including
              merchantability, fitness for a particular purpose and non-infringement. We do not
              guarantee that the Service will be uninterrupted or error-free, or that content will
              never be lost. Lumra is a sharing service, not a backup service: keep your own copies
              of your original photos. Link expiry settings control access, not guaranteed storage
              duration.
            </p>
          </Section>

          <Section id="liability" title="10. Limitation of liability">
            <p>
              To the extent permitted by law, Lumra will not be liable for indirect, incidental,
              special, consequential or punitive damages, or for lost profits, data or goodwill,
              arising from your use of the Service. Our total liability for any claim relating to
              the Service is limited to the greater of the fees you paid us in the 12 months before
              the claim and CAD $50. Nothing in these terms limits liability that cannot be limited
              by law, and some consumer rights cannot be waived.
            </p>
          </Section>

          <Section id="changes" title="11. Changes to these terms">
            <p>
              We may update these terms from time to time. We will change the &ldquo;Last
              updated&rdquo; date above and, for material changes, notify you by email or in the
              Service before they take effect. If you keep using Lumra after the changes take
              effect, you accept the updated terms.
            </p>
          </Section>

          <Section id="law" title="12. Governing law">
            <p>
              These terms are governed by the laws of the Province of Ontario and the federal laws
              of Canada applicable there, without regard to conflict-of-law rules. Disputes will be
              decided by the courts located in Ontario, except that nothing here limits mandatory
              consumer protections in the place where you live.
            </p>
          </Section>

          <Section id="contact" title="13. Contact">
            <p>
              Questions, notices or copyright and abuse reports can be sent to Lumra at{' '}
              <a href={`mailto:${CONTACT_EMAIL}`} className="underline">
                {CONTACT_EMAIL}
              </a>
              , or by post to {CONTACT_ADDRESS}.
            </p>
          </Section>
        </div>
      </main>
    </div>
  );
}
