import Link from 'next/link';
import { requireUser } from '@/lib/auth/session';
import { outstandingTerms } from '@/lib/terms';
import { signOut } from '@/app/(auth)/login/actions';
import { setPartnerAvailability } from './actions';
import EmailForm from './email-form';
import NameForm from './name-form';
import RewardProgress from '../reward-progress';
import SiteHeader from '../site-header';
import SiteFooter from '../site-footer';
import { Container } from '../ui';

export const metadata = { title: 'Account · Campus Dash' };
export const dynamic = 'force-dynamic';

/**
 * The account.
 *
 * ONE IDENTITY, SEVERAL CAPABILITIES, and this screen is where that is made
 * legible: Customer, Partner, Vendor and Admin are rows on the same account,
 * additive, and holding one never takes another away. Every one of them is read
 * from my_capabilities(), which derives from the database on each request.
 */
export default async function AccountPage() {
  const me = await requireUser();
  const outstanding = await outstandingTerms();

  return (
    <div className="min-h-dvh">
      <SiteHeader active="account" />
      <main className="pb-24 sm:pb-0">
        <Container size="narrow" className="pt-8 sm:pt-12">
          <div className="flex items-center gap-4">
            <span className="bg-brand-700 grid size-14 shrink-0 place-items-center rounded-full text-lg font-bold text-white">
              {(me.first_name ?? me.full_name ?? '?').trim().charAt(0).toUpperCase()}
            </span>
            <div className="min-w-0">
              <h1 className="text-display truncate text-2xl font-semibold sm:text-3xl">
                {me.full_name ?? 'Your account'}
              </h1>
              <p className="text-muted mt-1 text-sm tabular-nums">{me.phone}</p>
            </div>
          </div>

          {outstanding?.length ? (
            <Link
              href="/terms"
              className="rounded-card bg-warn-bg text-warn mt-6 block px-4 py-3 text-sm"
            >
              <span className="font-semibold">Updated terms need your agreement.</span> Tap to read
              and accept.
            </Link>
          ) : null}

          {me.can_order ? <RewardProgress className="mt-8" /> : null}

          <section className="mt-8">
            <h2 className="text-sm font-semibold tracking-wide uppercase">Your name</h2>
            <p className="text-muted mt-1 text-sm">
              Your first name is what a Partner sees when they bring your order, and what you see
              when one accepts it.
            </p>
            <NameForm firstName={me.first_name ?? null} lastName={me.last_name ?? null} />
          </section>

          <section className="mt-8">
            <h2 className="text-sm font-semibold tracking-wide uppercase">Email</h2>
            <p className="text-muted mt-1 text-sm">
              {me.email
                ? me.email
                : 'Not set. The payment page needs an email address, so you will be asked for one before you can pay.'}
            </p>
            <EmailForm email={me.email ?? null} />
          </section>

          <section className="mt-8">
            <h2 className="text-sm font-semibold tracking-wide uppercase">
              What this account can do
            </h2>
            <p className="text-muted mt-1 text-sm">
              One identity, one login. These are capabilities on it, and they are additive. Holding
              one never takes another away.
            </p>

            <div className="mt-4 space-y-2">
              <ModeRow
                title="Customer"
                enabled={me.can_order}
                detail={customerDetail(me)}
                action={me.can_order ? { href: '/order', label: 'Order' } : null}
              />
              <ModeRow
                title="Partner"
                enabled={me.is_partner}
                detail={partnerDetail(me.partner_status)}
                action={
                  me.is_partner
                    ? { href: '/partner', label: 'Deliveries' }
                    : me.can_order
                      ? { href: '/partner/apply', label: 'Become a Partner' }
                      : null
                }
              />
              <ModeRow
                title="Vendor"
                enabled={Boolean(me.vendor_ids?.length)}
                detail={
                  me.vendor_ids?.length
                    ? `You own ${me.vendor_ids.length} store${me.vendor_ids.length === 1 ? '' : 's'}.`
                    : 'You do not own a store on Campus Dash.'
                }
                action={me.vendor_ids?.length ? { href: '/vendor', label: 'Order board' } : null}
              />
              <ModeRow
                title="Admin"
                enabled={me.is_admin}
                detail={
                  me.is_admin
                    ? 'Full operational access. It does not replace your other capabilities.'
                    : 'No administrative access.'
                }
                action={me.is_admin ? { href: '/admin', label: 'Admin' } : null}
              />
            </div>

            {me.can_order ? (
              <p className="text-muted mt-3 text-xs">
                Student ID {me.student_id_number} · Level {me.level}
              </p>
            ) : null}
          </section>

          {me.is_partner ? (
            <section className="mt-8">
              <h2 className="text-sm font-semibold tracking-wide uppercase">Availability</h2>
              <p className="text-muted mt-1 text-sm">
                {me.partner_available
                  ? 'You are receiving delivery offers.'
                  : 'You are not receiving delivery offers.'}
              </p>
              <form action={setPartnerAvailability} className="mt-3">
                <input
                  type="hidden"
                  name="available"
                  value={me.partner_available ? 'false' : 'true'}
                />
                <button
                  type="submit"
                  className="press border-line-strong bg-surface rounded-full border px-4 py-2 text-sm font-semibold transition-colors"
                >
                  {me.partner_available ? 'Go offline' : 'Go online'}
                </button>
              </form>
            </section>
          ) : null}

          <form action={signOut} className="mt-10">
            <button
              type="submit"
              className="text-bad text-sm font-semibold underline underline-offset-4"
            >
              Sign out
            </button>
          </form>
        </Container>
      </main>
      <SiteFooter />
    </div>
  );
}

function customerDetail(me) {
  if (me.can_order) return 'Student details on file. You can place orders.';
  return 'Add your student details to order. Same account, nothing new to create.';
}

function partnerDetail(status) {
  switch (status) {
    case 'APPROVED':
      return 'Approved. You can accept deliveries.';
    case 'PENDING_REVIEW':
      return 'Application awaiting admin review.';
    case 'REJECTED':
      return 'Application was not approved.';
    case 'SUSPENDED':
      return 'Partner access is suspended.';
    default:
      return 'Not applied. You can add delivering to this account.';
  }
}

function ModeRow({ title, enabled, detail, action = null }) {
  return (
    <div className="rounded-card bg-surface border-line flex items-start gap-3 border px-4 py-3">
      <span
        className={`mt-0.5 size-2.5 shrink-0 rounded-full ${enabled ? 'bg-good' : 'bg-surface-3'}`}
        aria-hidden
      />
      <div className="min-w-0">
        <p className="font-medium">{title}</p>
        <p className="text-muted text-sm">{detail}</p>
      </div>
      {action ? (
        <Link
          href={action.href}
          className="text-brand-700 mt-0.5 ml-auto shrink-0 text-sm font-medium"
        >
          {action.label}
        </Link>
      ) : null}
    </div>
  );
}
