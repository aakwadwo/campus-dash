import 'server-only';

import { getPaymentProvider } from '@/lib/payments';
import { attachPayoutSubaccount, payoutDestinationFor } from '@/lib/orders/transitions';
import { deferNotification } from '@/lib/notifications/defer';
import { notifyAdminSubaccountCreated } from '@/lib/notifications/admin-email';
import { config } from '@/lib/config';

/**
 * Registering a payout destination with the provider.
 *
 * A destination is a mobile money account somebody typed in. Paystack needs it
 * described twice, because money travels in two directions and it models them
 * as different objects:
 *
 *   SUBACCOUNT  where it routes the vendor's share of a charge, at the moment
 *               the customer pays. Created here.
 *   RECIPIENT   where we push money to afterwards, from our own balance. Created
 *               lazily by the settlement run, because a payout may never happen.
 *
 * WHY THE SUBACCOUNT IS CREATED EAGERLY and the recipient is not: a subaccount
 * has to exist BEFORE the next order is charged or that order's split is simply
 * absent, and the vendor waits a settlement cycle for money that could have
 * been theirs immediately. A recipient can be made at the moment it is needed.
 *
 * NOTHING HERE THROWS AT THE CALLER. Saving a phone number must succeed even
 * when Paystack is unreachable: the number is right, the account is set up, and
 * the only thing missing is a code we can obtain later. The failure is recorded
 * on the destination row so an administrator can see it and retry.
 */
export async function syncPayoutSubaccount({ payeeType, payeeId, businessName, contactEmail }) {
  const provider = getPaymentProvider();

  if (provider.name === 'paystack' && !config.paystackSplitEnabled()) {
    return { ok: false, skipped: 'split settlement is switched off on this deployment' };
  }

  const destination = await payoutDestinationFor({ payeeType, payeeId });
  if (!destination) return { ok: false, skipped: 'no destination on file' };

  // Already registered with THIS provider. A code from another provider is not
  // a code at all here, so it is replaced rather than trusted.
  if (destination.provider === provider.name && destination.provider_subaccount_code) {
    return { ok: true, subaccountCode: destination.provider_subaccount_code, unchanged: true };
  }

  let created;
  try {
    created = await provider.ensureSubaccount({
      businessName,
      momoNetwork: destination.momo_network,
      accountNumber: destination.account_number,
      contactEmail: contactEmail ?? null,
    });
  } catch (error) {
    await recordFailure({ payeeType, payeeId, provider: provider.name, error: error.message });
    return { ok: false, error: error.message };
  }

  // A provider with no such concept returns null. That is not a failure — it
  // means every payout for this payee goes through a settlement run, which is
  // the path that existed before splits did.
  if (!created?.subaccountCode) {
    return { ok: false, skipped: `${provider.name} has no subaccounts` };
  }

  await attachPayoutSubaccount({
    payeeType,
    payeeId,
    provider: provider.name,
    subaccountCode: created.subaccountCode,
    error: null,
  });

  // THE ONE PLACE PAYSTACK HAS CONFIRMED A NEW SUBACCOUNT. Every other exit
  // from this function is a skip, a refusal or an already-registered
  // destination, so this line is reached exactly once per subaccount that
  // actually came into existence — which is what makes the email fire once for
  // a creation, never for a failure, and never again for a retry.
  //
  // DEFERRED, and it must stay deferred. The vendor is waiting on the response
  // that saves their payout details; an email to somebody else is a consequence
  // of that, not part of it. deferNotification() swallows its own failures, so
  // an unreachable mail provider cannot turn a successful registration into a
  // failed one.
  if (payeeType === 'VENDOR') {
    await deferNotification('vendor-subaccount-created', () =>
      notifyAdminSubaccountCreated({
        vendorName: businessName,
        accountName: destination.account_name ?? null,
        subaccountCode: created.subaccountCode,
        momoNetwork: destination.momo_network ?? null,
        accountNumber: destination.account_number ?? null,
        // Paystack reports these on the created subaccount. Absent on a
        // provider that has no such concept, which the template says plainly
        // rather than inventing.
        settlementSchedule: created.raw?.settlement_schedule ?? null,
        createdAt: created.raw?.createdAt ?? new Date().toISOString(),
      })
    );
  }

  return { ok: true, subaccountCode: created.subaccountCode };
}

async function recordFailure({ payeeType, payeeId, provider, error }) {
  try {
    await attachPayoutSubaccount({ payeeType, payeeId, provider, subaccountCode: null, error });
  } catch (caught) {
    // The destination itself is saved either way. Losing the note about why the
    // registration failed is worth strictly less than the number being stored.
    console.error(`[settlement] could not record a subaccount failure: ${caught.message}`);
  }
}
