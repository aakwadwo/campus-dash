import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { getPaymentProvider } from '@/lib/payments';
import { processPaymentWebhook } from '@/lib/payments/webhook';
import { config } from '@/lib/config';

/**
 * Customer payment.
 *
 * The customer asks to pay; everything else is server-side. They never supply
 * an amount — it comes from the order, which the server priced and snapshotted
 * — and they can never mark anything PAID, because only a verified provider
 * event does that.
 */

/** Confirms the order belongs to the signed-in customer. Returns it, or null. */
async function loadOwnOrder(orderId) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('customer_order_detail', { p_order_id: orderId });
  if (error) throw new Error(error.message);
  const rows = Array.isArray(data) ? data : [data];
  return rows[0] ?? null;
}

/**
 * Starts, or resumes, payment for an order.
 *
 * Idempotent in three layers, because a customer on a bad connection taps twice:
 *   1. an existing PENDING or SUCCEEDED payment is returned as-is;
 *   2. the idempotency key is derived from the attempt NUMBER, so two
 *      simultaneous taps compute the same key and the database returns one row;
 *   3. a partial unique index refuses a second live intent regardless.
 */
export async function startPayment(orderId) {
  const order = await loadOwnOrder(orderId);
  if (!order) throw new Error('order not found');

  if (order.order_status !== 'ACCEPTED') {
    return { ok: false, reason: 'This order is not waiting for payment.' };
  }
  if (order.payment_status === 'PAID') {
    return { ok: true, alreadyPaid: true };
  }

  const admin = createAdminClient();

  // Resume rather than start again.
  const { data: live } = await admin
    .from('payments')
    .select('id, status, provider_transaction_id')
    .eq('order_id', orderId)
    .in('status', ['PENDING', 'SUCCEEDED'])
    .order('created_at', { ascending: false })
    .limit(1);

  if (live?.length) {
    return { ok: true, paymentId: live[0].id, resumed: true };
  }

  // Attempt number, so a retry after a failure is a NEW payment while two
  // simultaneous taps are the same one.
  const { count } = await admin
    .from('payments')
    .select('id', { count: 'exact', head: true })
    .eq('order_id', orderId);

  const idempotencyKey = `order:${orderId}:attempt:${(count ?? 0) + 1}`;
  const provider = getPaymentProvider();

  const { data: created, error: intentError } = await admin.rpc('create_payment_intent', {
    p_order_id: orderId,
    p_provider: provider.name,
    p_idempotency_key: idempotencyKey,
  });
  if (intentError) throw new Error(intentError.message);

  const payment = Array.isArray(created) ? created[0] : created;

  // The amount comes from OUR record, which came from the order. Never from the
  // request that reached this function.
  const collection = await provider.initiateCollection({
    idempotencyKey,
    amountPesewas: payment.amount_pesewas,
    currency: payment.currency,
    customerPhone: null,
    reference: payment.id,
    metadata: { orderId },
  });

  await admin.rpc('attach_payment_transaction', {
    p_payment_id: payment.id,
    p_provider_transaction_id: collection.providerTransactionId,
  });

  return { ok: true, paymentId: payment.id };
}

/**
 * Reads the current payment state, and — in development only — delivers the
 * callback the fake provider cannot make itself.
 *
 * A real provider POSTs to /api/payments/webhook/[provider]. The fake one runs
 * in this process and has no way to reach us, so when it reports SUCCEEDED we
 * hand the very same event to the very same handler. The dedup, signature check
 * and state transition are all the production path; only the transport is
 * simulated.
 */
export async function refreshPaymentState(orderId) {
  const order = await loadOwnOrder(orderId);
  if (!order) throw new Error('order not found');

  if (order.payment_txn_status === 'PENDING' && order.payment_id) {
    const provider = getPaymentProvider();
    const admin = createAdminClient();

    const { data: rows } = await admin
      .from('payments')
      .select('provider_transaction_id')
      .eq('id', order.payment_id)
      .limit(1);

    const transactionId = rows?.[0]?.provider_transaction_id;
    if (transactionId) {
      const status = await provider.getStatus(transactionId);

      if (status.status !== 'PENDING' && !config.isProduction() && provider.name === 'fake') {
        const payload = provider.buildWebhookPayload(transactionId);
        if (payload) {
          await processPaymentWebhook({
            rawBody: JSON.stringify(payload),
            headers: { 'x-fake-signature': 'fake-signature' },
          });
        }
      }
    }

    return loadOwnOrder(orderId);
  }

  return order;
}
