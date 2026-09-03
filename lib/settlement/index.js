import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';
import { getPaymentProvider } from '@/lib/payments';
import {
  markPayoutProcessing,
  failPayout,
  retryPayout,
  payoutDestinationFor,
  attachPayoutRecipient,
} from '@/lib/orders/transitions';

/**
 * Settlement.
 *
 * Vendors are settled daily, Partners weekly. Campus Dash does not run a vendor
 * wallet: a settlement run gathers what is already owed and moves it out. What
 * a vendor sees is "earned / awaiting / settled", never a stored balance.
 *
 * Every step is idempotent, because the alternative is paying somebody twice:
 *   * a run for a period that already exists is RETURNED, not recreated;
 *   * allocations are claimed by the run, so a second run finds nothing;
 *   * one payout per payee per run, enforced by a unique index;
 *   * a payout can only be marked PAID from PENDING or PROCESSING, so however
 *     many attempts it takes, it is paid at most once.
 *
 * PROVIDER ACCEPTANCE IS NOT DELIVERY. A transfer the provider took is
 * PROCESSING. Only the transfer event that follows makes it PAID — or FAILED,
 * which releases the allocation claim so the money falls into the next run.
 *
 * The same release is what makes the minimum-payout threshold safe. A payee
 * under it gets no payout at all and their claim is dropped inside the run's
 * own transaction, so the liability sits in the pool accumulating until a later
 * run finds enough of it to be worth a transfer fee.
 */

/** Vendors settle for a calendar day; Partners for the week ending that day. */
export function periodFor(payeeType, endingAt = new Date()) {
  const end = new Date(endingAt);
  end.setUTCHours(0, 0, 0, 0);

  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (payeeType === 'PARTNER' ? 7 : 1));

  return { periodStart: start.toISOString(), periodEnd: end.toISOString() };
}

/**
 * Creates (or returns) the run for a period, then attempts every payout in it.
 *
 * Running this twice for the same period is a no-op the second time: the run
 * already exists, its allocations are already claimed, and its payouts are
 * already on their way.
 *
 * The minimum-payout threshold is NOT applied here. It is applied inside
 * create_settlement_run, before a payout row exists, so a below-threshold payee
 * has their claim released in the same transaction and their money is owed
 * again the moment the run returns. Holding it here — after the run had already
 * claimed the allocations — left the liability attached to a payout nothing
 * would ever send, and no later run could reach it. Every payout this function
 * sees is one that should actually go out.
 */
export async function runSettlement({ payeeType, periodStart, periodEnd }) {
  const supabase = createAdminClient();

  const { data: runRows, error: runError } = await supabase.rpc('create_settlement_run', {
    p_payee_type: payeeType,
    p_period_start: periodStart,
    p_period_end: periodEnd,
  });
  if (runError) throw new Error(runError.message);

  const run = Array.isArray(runRows) ? runRows[0] : runRows;

  const { data: payouts, error: payoutError } = await supabase
    .from('payouts')
    .select(
      'id, payee_type, payee_id, amount_pesewas, currency, status, idempotency_key, transfer_attempt'
    )
    .eq('settlement_run_id', run.id);
  if (payoutError) throw new Error(payoutError.message);

  const results = [];
  for (const payout of payouts ?? []) {
    results.push(await sendPayout(payout));
  }

  const failed = results.filter((r) => !r.ok).length;

  await supabase
    .from('settlement_runs')
    .update({
      status: failed > 0 ? 'FAILED' : 'COMPLETED',
      completed_at: new Date().toISOString(),
    })
    .eq('id', run.id);

  return {
    runId: run.id,
    payeeType,
    totalPesewas: run.total_pesewas,
    attempted: results.length,
    // "Accepted by the provider", which is what we actually know at this point.
    accepted: results.filter((r) => r.ok).length,
    failed,
    // Owed to payees under the threshold. The run did not claim it; it is back
    // in the pool and visible in admin_pending_settlement as still owed.
    deferredPayees: run.deferred_payee_count ?? 0,
    deferredPesewas: run.deferred_pesewas ?? 0,
    results,
  };
}

/**
 * The reference handed to the provider for one transfer attempt.
 *
 * Paystack requires transfer references to be unique, and a retry is the ONLY
 * recovery mechanism we have — nothing retries by itself. So the attempt number
 * is folded in: the first attempt is the payout id exactly, and every retry
 * after that is a reference the provider has never seen.
 *
 * Our own payout id and idempotency key are untouched by this. They stay the
 * anchors on OUR side; this is only what the provider is told. The suffix keeps
 * the payout id at the front so payout_for_transfer can still read it back off
 * an inbound event.
 *
 * Only `-`, `.`, `=` and alphanumerics are allowed in a Paystack reference,
 * which is why the separator is a hyphen.
 */
export function transferReferenceFor(payout) {
  const attempt = Number(payout.transfer_attempt ?? 0);
  return attempt > 0 ? `${payout.id}-r${attempt}` : payout.id;
}

/**
 * Resolves where a payout goes, registering the destination with the provider
 * the first time.
 *
 * The recipient code is stored on the destination, not the payout: it describes
 * a mobile money account somebody checked, and it outlives every individual
 * transfer. Re-registering per payout would litter the provider account and
 * lose that link.
 */
async function recipientFor(payout, provider) {
  const destination = await payoutDestinationFor({
    payeeType: payout.payee_type,
    payeeId: payout.payee_id,
  });

  // PLATFORM allocations are Campus Dash's own revenue; nothing is transferred,
  // and no destination is ever created for one.
  if (!destination) return null;

  let recipientCode =
    destination.provider === provider.name ? destination.provider_recipient_code : null;

  if (!recipientCode) {
    const created = await provider.ensureTransferRecipient({
      momoNetwork: destination.momo_network,
      accountNumber: destination.account_number,
      accountName: destination.account_name,
      currency: payout.currency ?? 'GHS',
    });

    if (created?.recipientCode) {
      await attachPayoutRecipient({
        payeeType: payout.payee_type,
        payeeId: payout.payee_id,
        provider: provider.name,
        recipientCode: created.recipientCode,
      });
      recipientCode = created.recipientCode;
    }
  }

  return {
    recipientCode,
    momoNetwork: destination.momo_network,
    accountNumber: destination.account_number,
    accountName: destination.account_name,
    name: destination.account_name,
  };
}

/**
 * What one transfer INITIATION result means for the payout.
 *
 * It cannot return PAID, and that is the whole point. Hard rule 11 says
 * provider acceptance is not delivery, and the rule holds even when the
 * provider's own initiation response already says "success": Paystack's test
 * mode answers that way for every transfer, its live response can too, and in
 * both cases `transferred_at` is still null — the transfer has been queued, not
 * delivered. Believing it would also settle the money with NO amount check,
 * because that response carries no independent figure; it only echoes the one
 * we just sent, so a guard built from it would prove nothing.
 *
 * So every non-fatal answer parks the payout at PROCESSING and waits for the
 * transfer webhook, which does carry the provider's own amount and is the only
 * event allowed to mark a payout PAID.
 *
 * FAILED and CANCELLED are the exception, and only because they are terminal: a
 * duplicate-reference resolution can come back already dead, and recording that
 * as PROCESSING would leave a payout waiting for an event that will never
 * arrive.
 *
 * @param {'PENDING'|'SUCCEEDED'|'FAILED'|'CANCELLED'|'REVERSED'} status
 * @returns {'PROCESSING'|'FAIL'}
 */
export function initiationOutcomeFor(status) {
  return status === 'FAILED' || status === 'CANCELLED' ? 'FAIL' : 'PROCESSING';
}

/**
 * Pushes one payout through the transfer adapter.
 *
 * Already-PAID payouts are skipped rather than re-sent, and mark_payout_paid
 * refuses anything that is not PENDING or PROCESSING — so the same payout
 * cannot be paid twice however many attempts it takes.
 *
 * This function never marks a payout PAID. See initiationOutcomeFor().
 *
 * Each attempt carries its OWN provider reference (transferReferenceFor), because
 * Paystack refuses a reference it has already seen and a retry would otherwise be
 * rejected outright. Our payout id and idempotency key are unchanged by that.
 */
export async function sendPayout(payout) {
  if (payout.status === 'PAID') {
    return { ok: true, payoutId: payout.id, skipped: 'already paid' };
  }

  const provider = getPaymentProvider();

  // Asked BEFORE a destination is registered anywhere. A deployment with
  // transfers switched off must not create recipients at the provider for
  // transfers it is not going to send.
  if (!provider.canSendTransfers) {
    const reason = `${provider.name} transfers are not enabled on this deployment`;
    await failPayout(payout.id, reason);
    return { ok: false, payoutId: payout.id, error: reason };
  }

  let recipient;
  try {
    recipient = await recipientFor(payout, provider);
  } catch (error) {
    await failPayout(payout.id, error.message);
    return { ok: false, payoutId: payout.id, error: error.message };
  }

  if (!recipient) {
    const reason = 'no payout destination on file for this payee';
    await failPayout(payout.id, reason);
    return { ok: false, payoutId: payout.id, error: reason };
  }

  try {
    const transfer = await provider.sendTransfer({
      idempotencyKey: payout.idempotency_key,
      amountPesewas: payout.amount_pesewas,
      currency: payout.currency ?? 'GHS',
      recipient,
      reference: transferReferenceFor(payout),
      reason: 'Campus Dash settlement',
    });

    // A duplicate-reference resolution can come back already dead. Recording it
    // as PROCESSING would leave a payout waiting for an event that will never
    // arrive, so it is failed here and the claim released.
    if (initiationOutcomeFor(transfer.status) === 'FAIL') {
      const reason = `provider reports this transfer as ${transfer.status}`;
      await failPayout(payout.id, reason);
      return { ok: false, payoutId: payout.id, error: reason };
    }

    await markPayoutProcessing({
      payoutId: payout.id,
      provider: provider.name,
      providerTransferId: transfer.providerTransferId,
    });

    return {
      ok: true,
      payoutId: payout.id,
      status: 'PROCESSING',
      providerTransferId: transfer.providerTransferId,
    };
  } catch (error) {
    // Releases the allocation claim, so what is owed goes back into the pool
    // rather than being stranded behind a dead payout row.
    await failPayout(payout.id, error.message);
    return { ok: false, payoutId: payout.id, error: error.message };
  }
}

/**
 * Retries only the payouts that failed, leaving the paid ones alone.
 *
 * MANUAL ONLY, and deliberately so: nothing in the system retries a transfer on
 * its own. An automatic loop against a payments API is how the same money gets
 * sent twice.
 *
 * A failed payout released its allocations, so retry_payout re-claims them
 * first. It refuses when a later run has already swept that money, which is a
 * state for a person to look at rather than something to force.
 */
export async function retryFailedPayouts(runId) {
  const supabase = createAdminClient();
  const { data: payouts } = await supabase
    .from('payouts')
    .select(
      'id, payee_type, payee_id, amount_pesewas, currency, status, idempotency_key, transfer_attempt'
    )
    .eq('settlement_run_id', runId)
    .eq('status', 'FAILED');

  const results = [];
  for (const payout of payouts ?? []) {
    const reclaimed = await retryPayout(payout.id);
    if (!reclaimed.success) {
      results.push({ ok: false, payoutId: payout.id, error: reclaimed.reason });
      continue;
    }
    results.push(await sendPayout({ ...payout, status: 'PENDING' }));
  }
  return results;
}
