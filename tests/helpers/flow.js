import { asService, asUser, ACTORS, VENDORS, MENU, LOCATIONS } from './db.js';

/**
 * Helpers that walk an order through the happy path, so each test can start
 * from the state it actually cares about.
 *
 * Note that every step goes through the same RPCs the application uses. The
 * tests never hand-write an UPDATE to force a state — if a transition is
 * reachable in a test, it is reachable in production.
 */

export async function submitOrder({
  customer = ACTORS.customerAma,
  vendorId = VENDORS.one,
  fulfilment = 'DELIVERY',
  items = [{ menu_item_id: MENU.jollof, quantity: 1 }],
  destination = LOCATIONS.room204,
} = {}) {
  return asUser(
    customer,
    async (c) => {
      const { rows } = await c.query(
        'select * from public.submit_order($1, $2, $3::jsonb, $4, $5)',
        [
          vendorId,
          fulfilment,
          JSON.stringify(items),
          fulfilment === 'DELIVERY' ? destination : null,
          null,
        ]
      );
      return rows[0];
    },
    { commit: true }
  );
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

/** Submitted -> accepted -> paid -> preparing -> READY (dispatch open). */
export async function orderReadyForDispatch(options = {}) {
  const order = await submitOrder(options);
  const staff = options.staff ?? ACTORS.vendor1Staff;
  await vendorAccept(order.order_id, staff);
  await payOrder(order.order_id);
  await vendorPrepare(order.order_id, staff);
  await vendorReady(order.order_id, staff);
  return order;
}

/** Returns the full envelope: { success, reason, order_number, pickup_code, vendor_name }. */
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

/** Walks an order all the way to DELIVERED, returning the codes used. */
export async function completeDelivery(
  orderId,
  partner = ACTORS.partnerYaw,
  staff = ACTORS.vendor1Staff
) {
  const secrets = await getSecrets(orderId);
  await tryTransition(staff, 'select public.vendor_confirm_pickup($1, $2)', [
    orderId,
    secrets.pickup_code,
  ]);
  await tryTransition(partner, 'select public.partner_complete_delivery($1, $2)', [
    orderId,
    secrets.delivery_code,
  ]);
  return secrets;
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
