import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { getPaymentProvider } from '@/lib/payments';
import { processPaymentWebhook } from '@/lib/payments/webhook';
import { confirmPayment, failPayment } from '@/lib/orders/transitions';
import { config } from '@/lib/config';

/**
 * Customer payment.
 *
 * The customer asks to pay; everything else is server-side. They never supply
 * an amount — it comes from the order, which the server priced and snapshotted
 * — and they can never mark anything PAID, because only a verified provider
 * event does that.
 *
 * With hosted checkout there is one extra rule, and it is the important one:
 * THE BROWSER COMING BACK IS NOT PROOF OF PAYMENT. Anyone can open the return
 * URL. What the return does is trigger a server-to-server verification against
 * the provider; that verified answer — or the signed webhook, whichever arrives
 * first — is the only thing that moves money.
 */

/** Confirms the order belongs to the signed-in customer. Returns it, or null. */
async function loadOwnOrder(orderId) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('customer_order_detail', { p_order_id: orderId });
  if (error) throw new Error(error.message);
  const rows = Array.isArray(data) ? data : [data];
  return rows[0] ?? null;
}

/** The signed-in customer's own email, from the database. Never synthesised. */
async function myEmail() {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('my_capabilities');
  if (error) throw new Error(error.message);
  return data?.email ?? null;
}

/**
 * Starts, or resumes, payment for an order.
 *
 * Idempotent in three layers, because a customer on a bad connection taps twice:
 *   1. an existing PENDING or SUCCEEDED payment is returned as-is;
 *   2. the idempotency key is derived from the attempt NUMBER, so two
 *      simultaneous taps compute the same key and the database returns one row;
 *   3. a partial unique index refuses a second live intent regardless.
 *
 * Returns `redirectUrl` when the provider hosts the checkout. The caller MUST
 * send the customer there — a redirect URL that is returned and dropped is a
 * payment that was never started.
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

  const provider = getPaymentProvider();
  const admin = createAdminClient();

  // Asked BEFORE anything is created, so a customer with no address on file is
  // stopped here rather than at a checkout that would reject them.
  let customerEmail = null;
  if (provider.requiresCustomerEmail) {
    customerEmail = await myEmail();
    if (!customerEmail) {
      return {
        ok: false,
        needsEmail: true,
        reason: 'We need your email address before you can pay.',
      };
    }
  }

  // Resume rather than start again.
  const { data: live } = await admin
    .from('payments')
    .select('id, status, provider_transaction_id')
    .eq('order_id', orderId)
    .in('status', ['PENDING', 'SUCCEEDED'])
    .order('created_at', { ascending: false })
    .limit(1);

  if (live?.length) {
    // The SAME checkout, not a second one. Re-initialising would either open a
    // second provider transaction for one order or be refused as a duplicate
    // reference, so the URL is read back from where it was stored.
    const { data: url } = await admin.rpc('payment_checkout_url', { p_payment_id: live[0].id });
    return { ok: true, paymentId: live[0].id, resumed: true, redirectUrl: url ?? null };
  }

  // Attempt number, so a retry after a failure is a NEW payment while two
  // simultaneous taps are the same one.
  const { count } = await admin
    .from('payments')
    .select('id', { count: 'exact', head: true })
    .eq('order_id', orderId);

  const idempotencyKey = `order:${orderId}:attempt:${(count ?? 0) + 1}`;

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
    customerEmail,
    reference: payment.id,
    metadata: { orderId },
  });

  // The checkout URL is stored, not just returned: a customer who backgrounds
  // the tab and comes back must be sent to the same checkout.
  await admin.rpc('attach_payment_transaction', {
    p_payment_id: payment.id,
    p_provider_transaction_id: collection.providerTransactionId,
    p_raw: collection.redirectUrl ? { authorization_url: collection.redirectUrl } : null,
  });

  return { ok: true, paymentId: payment.id, redirectUrl: collection.redirectUrl ?? null };
}

/**
 * Asks the provider what actually happened, and applies the answer.
 *
 * This is the authoritative path, and it is what both the browser return and
 * the polling screen go through. It exists separately from the webhook because
 * a webhook can be late, lost or blocked by a firewall, and a customer standing
 * at a counter cannot wait for one — but the ANSWER still has to come from the
 * provider, never from the fact that a browser arrived at a URL.
 *
 * Idempotent: confirm_payment returns early on an already-succeeded payment,
 * and a payment that is no longer PENDING is left alone.
 */
export async function verifyAndApplyPayment(paymentId) {
  const provider = getPaymentProvider();
  const admin = createAdminClient();

  const { data: rows } = await admin
    .from('payments')
    .select('id, order_id, status, provider_transaction_id, amount_pesewas')
    .eq('id', paymentId)
    .limit(1);

  const payment = rows?.[0];
  if (!payment) return { ok: false, reason: 'unknown payment' };
  if (payment.status !== 'PENDING') {
    return { ok: true, orderId: payment.order_id, status: payment.status, alreadySettled: true };
  }
  if (!payment.provider_transaction_id) {
    return { ok: false, orderId: payment.order_id, reason: 'payment has no provider transaction' };
  }

  const verified = await provider.getStatus(payment.provider_transaction_id);

  try {
    if (verified.status === 'SUCCEEDED') {
      // The amount comes from the PROVIDER's answer, and confirm_payment
      // refuses it unless it matches what we asked for to the pesewa.
      await confirmPayment({
        paymentId: payment.id,
        providerTransactionId: payment.provider_transaction_id,
        amountPesewas: verified.amountPesewas,
      });
    } else if (verified.status === 'FAILED' || verified.status === 'CANCELLED') {
      await failPayment(payment.id, `provider reported ${verified.status}`);
    }
  } catch (error) {
    // A webhook that got here first will have moved the row already, which
    // makes the conditional update find nothing. That is a race we expect, not
    // a fault, and the payment is in the right state either way.
    console.error(`[payments] verify could not apply ${payment.id}: ${error.message}`);
  }

  return { ok: true, orderId: payment.order_id, status: verified.status };
}

/**
 * Reads the current payment state, reconciling with the provider when a charge
 * is still in flight.
 *
 * A real provider POSTs to /api/payments/webhook/[provider], and this polling
 * path is the safety net for when that never arrives. The fake provider runs in
 * this process and has no way to reach us at all, so when it reports SUCCEEDED
 * we hand the very same event to the very same handler. The dedup, signature
 * check and state transition are all the production path; only the transport is
 * simulated.
 */
export async function refreshPaymentState(orderId) {
  const order = await loadOwnOrder(orderId);
  if (!order) throw new Error('order not found');

  if (order.payment_txn_status === 'PENDING' && order.payment_id) {
    const provider = getPaymentProvider();

    if (provider.name === 'fake' && !config.isProduction()) {
      const admin = createAdminClient();
      const { data: rows } = await admin
        .from('payments')
        .select('provider_transaction_id')
        .eq('id', order.payment_id)
        .limit(1);

      const transactionId = rows?.[0]?.provider_transaction_id;
      if (transactionId) {
        const status = await provider.getStatus(transactionId);
        if (status.status !== 'PENDING') {
          const payload = provider.buildWebhookPayload(transactionId);
          if (payload) {
            await processPaymentWebhook({
              // Named explicitly, because the handler now checks that the
              // caller asked for the adapter this deployment actually serves.
              // The branch above has already established both, twice over.
              provider: provider.name,
              rawBody: JSON.stringify(payload),
              headers: { 'x-fake-signature': 'fake-signature' },
            });
          }
        }
      }
    } else {
      await verifyAndApplyPayment(order.payment_id);
    }

    return loadOwnOrder(orderId);
  }

  return order;
}
