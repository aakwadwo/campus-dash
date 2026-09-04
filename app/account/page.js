import Link from 'next/link';
import { requireUser } from '@/lib/auth/session';
import { outstandingTerms } from '@/lib/terms';
import { signOut } from '@/app/(auth)/login/actions';
import { setPartnerAvailability } from './actions';
import EmailForm from './email-form';

export const metadata = { title: 'Account · Campus Dash' };
export const dynamic = 'force-dynamic';

/**
 * Minimal account screen. It exists to prove the auth work: that a session is
 * real, that capabilities come from the database, and that one account can hold
 * both Customer and Partner roles. It is not the finished UI.
 */
export default async function AccountPage() {
  const me = await requireUser();
  const outstanding = await outstandingTerms();

  return (
    <main className="mx-auto max-w-lg px-6 py-12">
      <p className="text-muted text-xs font-medium tracking-[0.2em] uppercase">Campus Dash</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">
        {me.full_name ?? 'Your account'}
      </h1>
      <p className="text-muted mt-1 text-sm tabular-nums">{me.phone}</p>

      {outstanding?.length ? (
        <Link
          href="/terms"
          className="mt-6 block rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          <span className="font-semibold">Updated terms need your agreement.</span> Tap to read and
          accept.
        </Link>
      ) : null}

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
        <h2 className="text-sm font-semibold tracking-wide uppercase">What this account can do</h2>
        <p className="text-muted mt-1 text-sm">
          One identity, one login. These are capabilities on it, and they are additive — holding one
          never takes another away.
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
                ? `Staff at ${me.vendor_ids.length} stall${me.vendor_ids.length === 1 ? '' : 's'}.`
                : 'Not linked to a stall. An administrator adds vendor staff.'
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
            Student ID {me.student_id_number} · {me.class_year}
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
            <input type="hidden" name="available" value={me.partner_available ? 'false' : 'true'} />
            <button
              type="submit"
              className="rounded-lg border border-black/15 bg-white px-4 py-2 text-sm font-semibold"
            >
              {me.partner_available ? 'Go offline' : 'Go online'}
            </button>
          </form>
        </section>
      ) : null}

      <section className="mt-10">
        <details className="text-sm">
          <summary className="text-muted cursor-pointer">Capabilities (from the database)</summary>
          <pre className="mt-2 overflow-x-auto rounded-lg bg-black/5 p-3 text-xs">
            {JSON.stringify(me, null, 2)}
          </pre>
        </details>
      </section>

      <form action={signOut} className="mt-8">
        <button
          type="submit"
          className="text-sm font-semibold text-red-700 underline underline-offset-4"
        >
          Sign out
        </button>
      </form>
    </main>
  );
}

function customerDetail(me) {
  if (me.can_order) return 'Student details on file — you can place orders.';
  return 'Add your student details to order. Same account, nothing new to create.';
}

function partnerDetail(status) {
  switch (status) {
    case 'APPROVED':
      return 'Approved — you can accept deliveries.';
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
    <div className="flex items-start gap-3 rounded-lg bg-white px-4 py-3 ring-1 ring-black/5">
      <span
        className={`mt-0.5 size-2.5 shrink-0 rounded-full ${enabled ? 'bg-brand-700' : 'bg-black/20'}`}
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
          {action.label} →
        </Link>
      ) : null}
    </div>
  );
}
