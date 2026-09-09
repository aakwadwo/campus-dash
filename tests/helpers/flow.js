import { asService, asUser, ACTORS, VENDORS, MENU, LOCATIONS } from './db.js';

/**
 * Helpers that walk an order through the happy path, so each test can start
 * from the state it actually cares about.
 *
 * Note that every step goes through the same RPCs the application uses. The
 * tests never hand-write an UPDATE to force a state — if a transition is
 * reachable in a test, it is reachable in production.
 */

/**
 * Submits an order. A VENDOR AND SOME ITEMS — that is the whole submission.
 *
 * Pickup or delivery is a separate step now, taken after the vendor accepts,
 * so it is not a parameter here. `chooseFulfilment` below is that step, and
 * `acceptedOrder` runs the two in the order the product does.
 */
export async function submitOrder({
  customer = ACTORS.customerAma,
  vendorId = VENDORS.one,
  items = [{ menu_item_id: MENU.jollof, quantity: 1 }],
} = {}) {
  return asUser(
    customer,
    async (c) => {
      const { rows } = await c.query('select * from public.submit_order($1, $2::jsonb)', [
        vendorId,
        JSON.stringify(items),
      ]);
      return rows[0];
    },
    { commit: true }
  );
}

/**
 * Pickup or delivery, chosen by the customer between acceptance and payment.
 *
 * Returns the transition envelope so a test can assert on a refusal rather than
 * only on a success.
 */
export async function chooseFulfilment(
  orderId,
  {
    customer = ACTORS.customerAma,
    fulfilment = 'DELIVERY',
    destination = LOCATIONS.room204,
    note = null,
  } = {}
) {
  return transition(customer, 'select public.customer_choose_fulfilment($1, $2, $3, $4)', [
    orderId,
    fulfilment,
    fulfilment === 'DELIVERY' ? destination : null,
    note,
  ]);
}

/** Runs a transition RPC and fails loudly if the envelope says it was rejected. */
async function transition(userId, sql, params) {
  const result = await asUser(userId, async (c) => (await c.query(sql, params)).rows[0], {
    commit: true,
  });
  const envelope = Object.values(result)[0];
  const parsed = typeof envelope === 'string' ? parseComposite(envelope) : envelope;
  if (parsed.success === false || parsed.success === 'f') {
    throw new Error(`transition rejected: ${parsed.reason}`);
  }
  return parsed;
}

/** node-postgres returns an unregistered composite type as "(t,)" text. */
export function parseComposite(text) {
  const inner = text.replace(/^\(|\)$/g, '');
  const [success, ...rest] = inner.split(',');
  return { success: success === 't', reason: rest.join(',').replace(/^"|"$/g, '') || null };
}

export async function vendorAccept(orderId, staff = ACTORS.vendor1Staff) {
  return transition(staff, 'select public.vendor_accept_order($1)', [orderId]);
}

/**
 * Submitted -> ACCEPTED -> fulfilment chosen. The state most tests want as a
 * starting point, because it is the first one at which an order can be paid.
 */
export async function acceptedOrder(options = {}) {
  const order = await submitOrder(options);
  await vendorAccept(order.order_id, options.staff ?? ACTORS.vendor1Staff);
  await chooseFulfilment(order.order_id, {
    customer: options.customer ?? ACTORS.customerAma,
    fulfilment: options.fulfilment ?? 'DELIVERY',
    destination: options.destination ?? LOCATIONS.room204,
  });
  return order;
}

/** Attempts a transition and returns the raw envelope without throwing. */
export async function tryTransition(userId, sql, params) {
  const result = await asUser(userId, async (c) => (await c.query(sql, params)).rows[0], {
    commit: true,
  });
  const envelope = Object.values(result)[0];
  return typeof envelope === 'string' ? parseComposite(envelope) : envelope;
}

/** Pays an order the way the system does: intent, then provider confirmation. */
export async function payOrder(orderId, { key = `pay-${orderId}` } = {}) {
  return asService(async (c) => {
    const { rows } = await c.query("select * from public.create_payment_intent($1, 'fake', $2)", [
      orderId,
      key,
    ]);
    const payment = rows[0];
    await c.query('select public.confirm_payment($1, $2, $3)', [
      payment.id,
      `fake_txn_${payment.id}`,
      payment.amount_pesewas,
    ]);
    return payment;
  });
}

export async function vendorPrepare(orderId, staff = ACTORS.vendor1Staff) {
  return transition(staff, 'select public.vendor_mark_preparing($1)', [orderId]);
}

export async function vendorReady(orderId, staff = ACTORS.vendor1Staff) {
  return transition(staff, 'select public.vendor_mark_ready($1)', [orderId]);
}

/** Submitted -> accepted -> chosen -> paid -> preparing -> READY (dispatch open). */
export async function orderReadyForDispatch(options = {}) {
  const order = await acceptedOrder(options);
  const staff = options.staff ?? ACTORS.vendor1Staff;
  await payOrder(order.order_id);
  await vendorPrepare(order.order_id, staff);
  await vendorReady(order.order_id, staff);
  return order;
}

/**
 * Returns the full envelope: { success, reason, order_number, vendor_name }.
 *
 * NO PICKUP CODE. The claim does not hand one back any more — the code belongs
 * to the vendor, who reads it out, and the Partner types in what they hear.
 */
export async function partnerAccept(orderId, partner = ACTORS.partnerYaw) {
  return asUser(
    partner,
    async (c) => {
      const { rows } = await c.query('select * from public.partner_accept_delivery($1)', [orderId]);
      return rows[0];
    },
    { commit: true }
  );
}

/**
 * Walks an order all the way to DELIVERED, returning the codes used.
 *
 * BOTH CODES NOW TRAVEL THE SAME WAY: the counterparty holds the secret and the
 * Partner types it in. The vendor reads out the pickup code; the customer reads
 * out the delivery code. Reading them here from order_secrets is a test
 * shortcut for "somebody said the number out loud" — no client role can select
 * that table.
 */
export async function completeDelivery(orderId, partner = ACTORS.partnerYaw) {
  const secrets = await getSecrets(orderId);
  await tryTransition(partner, 'select public.partner_confirm_pickup($1, $2)', [
    orderId,
    secrets.pickup_code,
  ]);
  await tryTransition(partner, 'select public.partner_complete_delivery($1, $2)', [
    orderId,
    secrets.delivery_code,
  ]);
  return secrets;
}

/** The Partner half of the handoff, on its own. */
export async function partnerConfirmPickup(orderId, partner = ACTORS.partnerYaw, code = null) {
  const pickupCode = code ?? (await getSecrets(orderId)).pickup_code;
  return tryTransition(partner, 'select public.partner_confirm_pickup($1, $2)', [
    orderId,
    pickupCode,
  ]);
}

export async function getOrder(orderId) {
  return asService(async (c) => {
    const { rows } = await c.query('select * from public.orders where id = $1', [orderId]);
    return rows[0];
  });
}

export async function getSecrets(orderId) {
  return asService(async (c) => {
    const { rows } = await c.query('select * from public.order_secrets where order_id = $1', [
      orderId,
    ]);
    return rows[0];
  });
}

export async function getAllocations(orderId) {
  return asService(async (c) => {
    const { rows } = await c.query(
      'select * from public.allocations where order_id = $1 order by payee_type',
      [orderId]
    );
    return rows;
  });
}

/** Asserts that a promise rejects, and returns the error for inspection. */
export async function expectRejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the operation to be rejected, but it succeeded');
}

/**
 * Sets the Partner weekly payout threshold, in pesewas.
 *
 * A Partner earns GH₵5 per delivery and the product floor is GH₵20, so a test
 * about payout MECHANICS — one payout per payee, no duplicates, transfer
 * lifecycle — has to say which policy it is running under rather than depending
 * on whatever the default happens to be. Tests about the THRESHOLD itself set
 * it deliberately and assert the rollover.
 */
export async function setPartnerPayoutThreshold(pesewas) {
  await asService((c) =>
    c.query('update public.pricing_config set partner_min_payout_pesewas = $1', [pesewas])
  );
}
