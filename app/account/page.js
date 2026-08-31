import Link from 'next/link';
import { requireUser } from '@/lib/auth/session';
import { outstandingTerms } from '@/lib/terms';
import { signOut } from '@/app/(auth)/login/actions';
import { setPartnerAvailability } from './actions';

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
        <h2 className="text-sm font-semibold tracking-wide uppercase">Modes</h2>
        <p className="text-muted mt-1 text-sm">
          One account, one login. Partner is a capability on this same account.
        </p>

        <div className="mt-4 space-y-2">
          <ModeRow
            title="Ordering"
            enabled={me.can_order}
            detail={me.can_order ? 'Phone verified — you can place orders.' : 'Unavailable.'}
          />
          <ModeRow
            title="Partner"
            enabled={me.is_partner}
            detail={partnerDetail(me.partner_status)}
          />
          {me.is_admin ? <ModeRow title="Admin" enabled detail="Full operational access." /> : null}
        </div>
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
      return 'Not applied. Partner sign-up arrives in Phase 8.';
  }
}

function ModeRow({ title, enabled, detail }) {
  return (
    <div className="flex items-start gap-3 rounded-lg bg-white px-4 py-3 ring-1 ring-black/5">
      <span
        className={`mt-0.5 size-2.5 shrink-0 rounded-full ${enabled ? 'bg-brand-600' : 'bg-black/20'}`}
        aria-hidden
      />
      <div>
        <p className="font-medium">{title}</p>
        <p className="text-muted text-sm">{detail}</p>
      </div>
    </div>
  );
}
