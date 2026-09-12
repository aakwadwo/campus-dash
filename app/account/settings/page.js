import Link from 'next/link';
import { requireUser } from '@/lib/auth/session';
import { signOut } from '@/app/(auth)/login/actions';
import { outstandingTerms } from '@/lib/terms';
import ProfileForm from '../profile-form';
import EmailForm from '../email-form';
import { Panel } from '../../ui';

export const metadata = { title: 'Settings · Campus Dash' };
export const dynamic = 'force-dynamic';

/**
 * Settings, which is a short page on purpose.
 *
 * It holds the three things somebody might genuinely need to change — their
 * name, the address a receipt goes to, and the number a Partner rings — and
 * then it stops. It is NOT where the account model is explained: that used to
 * be a list of four capability rows on the main account screen, and it taught
 * people an architecture instead of letting them do anything.
 *
 * There is no "update terms" control here either. Terms change when Campus Dash
 * changes them; a customer has no reason to update anything, and a button
 * saying so was one of the stranger things in the old screen. When a new
 * version is published, a banner appears with the one thing to do about it.
 */
export default async function AccountSettingsPage() {
  const me = await requireUser('/account/settings');
  const outstanding = await outstandingTerms();

  // A store owner signs in with their number, so it is a credential rather than
  // a profile field. The database enforces that; the form just stops offering it.
  const phoneIsCredential = Boolean(me.vendor_ids?.length) || me.is_admin;

  return (
    <div>
      <header>
        <h1 className="text-display text-2xl font-semibold sm:text-3xl">Settings</h1>
        <p className="text-muted mt-1.5 text-sm">
          Your details. One account, whatever you use Campus Dash for.
        </p>
      </header>

      <div className="mt-6 space-y-5">
        <Panel title="Your details">
          <ProfileForm
            firstName={me.first_name ?? null}
            lastName={me.last_name ?? null}
            phone={me.phone ?? null}
            phoneIsCredential={phoneIsCredential}
          />
        </Panel>

        <Panel
          title="Email"
          description={
            me.email
              ? 'Where your receipts go, and what the payment page needs.'
              : 'Not set. The payment page needs an email address, so you will be asked for one before you can pay.'
          }
        >
          <EmailForm email={me.email ?? null} />
        </Panel>

        {outstanding?.length ? (
          <Panel
            title="Terms"
            description="A new version has been published and needs your agreement."
          >
            <Link href="/terms" className="text-brand-700 text-sm font-semibold">
              Read and accept →
            </Link>
          </Panel>
        ) : null}

        <form action={signOut} className="pt-2">
          <button
            type="submit"
            className="text-bad text-sm font-semibold underline underline-offset-4"
          >
            Sign out
          </button>
        </form>
      </div>
    </div>
  );
}
