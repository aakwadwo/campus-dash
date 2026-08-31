import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';
import { getPaymentProvider } from '@/lib/payments';

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
 *   * the transfer carries the payout's own idempotency key, so a retried
 *     transfer is the same transfer.
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
 * already PAID.
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
    .select('id, payee_type, payee_id, amount_pesewas, currency, status, idempotency_key')
    .eq('settlement_run_id', run.id);
  if (payoutError) throw new Error(payoutError.message);

  // Below the threshold a transfer costs more in fees than it moves. Those
  // payouts are left PENDING and swept into the next run rather than failed —
  // the money is still owed, it is just not worth moving yet.
  const { data: configRows } = await supabase.rpc('platform_config');
  const config = Array.isArray(configRows) ? configRows[0] : configRows;
  const minimum = Number(config?.min_payout_pesewas ?? 0);

  const results = [];
  const held = [];

  for (const payout of payouts ?? []) {
    if (minimum > 0 && payout.amount_pesewas < minimum && payout.status !== 'PAID') {
      held.push(payout.id);
      continue;
    }
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
    paid: results.filter((r) => r.ok).length,
    failed,
    heldBelowThreshold: held.length,
    results,
  };
}

/**
 * Pushes one payout through the transfer adapter.
 *
 * Already-PAID payouts are skipped rather than re-sent. The provider is also
 * given the payout's idempotency key, so even a retry that gets past this check
 * is the same transfer on their side.
 */
export async function sendPayout(payout) {
  const supabase = createAdminClient();

  if (payout.status === 'PAID') {
    return { ok: true, payoutId: payout.id, skipped: 'already paid' };
  }

  const provider = getPaymentProvider();
  const recipient = await recipientFor(payout);

  if (!recipient?.phone) {
    const reason = 'no payout destination on file for this payee';
    await supabase
      .from('payouts')
      .update({ status: 'FAILED', failure_reason: reason })
      .eq('id', payout.id);
    return { ok: false, payoutId: payout.id, error: reason };
  }

  try {
    const transfer = await provider.sendTransfer({
      idempotencyKey: payout.idempotency_key,
      amountPesewas: payout.amount_pesewas,
      currency: payout.currency ?? 'GHS',
      recipient,
      reference: payout.id,
    });

    // The fake provider settles asynchronously, exactly as a real one does.
    // Marking PAID on acceptance is right for it; a real adapter would wait for
    // the transfer webhook, which is why this goes through mark_payout_paid()
    // rather than writing the row directly.
    const { error } = await supabase.rpc('mark_payout_paid', {
      p_payout_id: payout.id,
      p_provider: provider.name,
      p_provider_transfer_id: transfer.providerTransferId,
    });
    if (error) throw new Error(error.message);

    return { ok: true, payoutId: payout.id, providerTransferId: transfer.providerTransferId };
  } catch (error) {
    await supabase
      .from('payouts')
      .update({ status: 'FAILED', failure_reason: error.message })
      .eq('id', payout.id);
    return { ok: false, payoutId: payout.id, error: error.message };
  }
}

/** Where the money goes. A vendor's own number; a Partner's account number. */
async function recipientFor(payout) {
  const supabase = createAdminClient();

  if (payout.payee_type === 'VENDOR') {
    const { data } = await supabase
      .from('vendors')
      .select('name, phone')
      .eq('id', payout.payee_id)
      .maybeSingle();
    return data ? { phone: data.phone, name: data.name } : null;
  }

  if (payout.payee_type === 'PARTNER') {
    const { data } = await supabase
      .from('users')
      .select('full_name, phone')
      .eq('id', payout.payee_id)
      .maybeSingle();
    return data ? { phone: data.phone, name: data.full_name } : null;
  }

  // PLATFORM allocations are Campus Dash's own revenue; nothing is transferred.
  return null;
}

/** Retries only the payouts that failed, leaving the paid ones alone. */
export async function retryFailedPayouts(runId) {
  const supabase = createAdminClient();
  const { data: payouts } = await supabase
    .from('payouts')
    .select('id, payee_type, payee_id, amount_pesewas, currency, status, idempotency_key')
    .eq('settlement_run_id', runId)
    .eq('status', 'FAILED');

  const results = [];
  for (const payout of payouts ?? []) {
    // Reset to PENDING so mark_payout_paid()'s state guard accepts it.
    await supabase.from('payouts').update({ status: 'PENDING' }).eq('id', payout.id);
    results.push(await sendPayout({ ...payout, status: 'PENDING' }));
  }
  return results;
}
