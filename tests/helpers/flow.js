import { asService, asUser, ACTORS, VENDORS, MENU, SCAN_MENU, LOCATIONS } from './db.js';

/**
 * Helpers that walk an order through the happy path, so each test can start
 * from the state it actually cares about.
 *
 * Note that every step goes through the same RPCs the application uses. The
 * tests never hand-write an UPDATE to force a state — if a transition is
 * reachable in a test, it is reachable in production.
 */

/**
 * Submits an order: a store, some items, and how the customer wants it.
 *
 * PICKUP OR DELIVERY IS PART OF THE SUBMISSION now. There is no vendor
 * acceptance to put it after — the order is priced in full at the checkout and
 * a store only sees it once it has been paid for. What comes back is already
 * payable, which is why `acceptedOrder` below is simply this.
 */
export async function submitOrder({
  customer = ACTORS.customerAma,
  vendorId = VENDORS.one,
  items = [{ menu_item_id: MENU.jollof, quantity: 1 }],
  fulfilment = 'DELIVERY',
  destination = LOCATIONS.room204,
  // Additional information, for the Partner.
  note = null,
  // Order information, for the store.
  orderNote = null,
} = {}) {
  return asUser(
    customer,
    async (c) => {
      const { rows } = await c.query(
        'select * from public.submit_order($1, $2::jsonb, $3, $4, $5, $6)',
        [
          vendorId,
          JSON.stringify(items),
          fulfilment,
          fulfilment === 'DELIVERY' ? destination : null,
          note,
          orderNote,
        ]
      );
      return rows[0];
    },
    { commit: true }
  );
}

/**
 * CHANGING pickup or delivery, after submission and before payment.
 *
 * Returns the transition envelope so a test can assert on a refusal rather than
 * only on a success.
 */
/**
 * Submits a MEAL SCAN order.
 *
 * The same shape as submitOrder() because a scan order IS a store order: real
 * items, a fulfilment choice, a queue number. The scan is the extra argument,
 * and the optional note is genuinely optional.
 *
 * Here rather than copied into five files, because the signature has changed
 * once already and every copy of it had to be found by running the suite.
 */
export async function submitScanOrder({
  customer = ACTORS.customerAma,
  vendorId = VENDORS.wafflemania,
  items = null,
  fulfilment = 'DELIVERY',
  destination = LOCATIONS.room204,
  path = null,
  // Order information. p_details is its parameter name on a scan order.
  details = null,
  orderNote = null,
  note = null,
  wantsPack = false,
} = {}) {
  const chosen =
    items ??
    (vendorId === VENDORS.yellowBar
      ? [{ menu_item_id: SCAN_MENU.tilapia, quantity: 1 }]
      : [{ menu_item_id: SCAN_MENU.waffle, quantity: 1 }]);

  return asUser(
    customer,
    async (c) =>
      (
        await c.query(
          `select * from public.submit_scan_order(
             $1, $2::jsonb, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            vendorId,
            JSON.stringify(chosen),
            fulfilment,
            path ?? `${customer}/scans/scan-1.jpg`,
            'image/jpeg',
            120000,
            fulfilment === 'DELIVERY' ? destination : null,
            orderNote ?? details,
            note,
            wantsPack,
          ]
        )
      ).rows[0],
    { commit: true }
  );
}

/** The store checks a meal scan. Redemption is the store's act, not a Partner's. */
export async function vendorRedeemScan(orderId, staff = ACTORS.wafflemaniaStaff) {
  return asUser(
    staff,
    async (c) => (await c.query('select * from public.vendor_redeem_scan($1)', [orderId])).rows[0],
    { commit: true }
  );
}

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

/**
 * An order that is priced and payable.
 *
 * Kept as a named helper because dozens of tests start here and the name still
 * says what the state IS — but it no longer involves a vendor. There is nothing
 * to accept: submission produces this state directly.
 */
export async function acceptedOrder(options = {}) {
  return submitOrder(options);
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

export async function vendorReady(orderId, staff = ACTORS.vendor1Staff) {
  return transition(staff, 'select public.vendor_mark_ready($1)', [orderId]);
}

/**
 * Placed -> paid -> READY.
 *
 * There is no separate "start preparing" step: confirm_payment() moves a paid
 * food order straight into PREPARING, because the store's whole job is to make
 * it. Dispatch also opens at payment, so by the time this returns a delivery
 * order has been SEARCHING since the money landed.
 */
export async function orderReadyForDispatch(options = {}) {
  const order = await acceptedOrder(options);
  await payOrder(order.order_id);
  await vendorReady(order.order_id, options.staff ?? ACTORS.vendor1Staff);
  return order;
}

/**
 * Placed and paid, and therefore PREPARING with dispatch already open.
 *
 * The state a Partner meets most often now: the offer exists, the food does
 * not yet. Tests that care about the difference start here.
 */
export async function paidOrder(options = {}) {
  const order = await acceptedOrder(options);
  await payOrder(order.order_id);
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

/**
 * The customer collects, by typing in the code the vendor read out.
 *
 * The direction is the point: the STORE holds the four digits and the person
 * taking the food types them in, exactly as a Partner does. Reading the code
 * from order_secrets here is a test shortcut for "somebody said the number out
 * loud" — no client role can select that table.
 */
export async function customerCollect(orderId, customer = ACTORS.customerAma, code = null) {
  const pickupCode = code ?? (await getSecrets(orderId)).pickup_code;
  return tryTransition(customer, 'select public.customer_complete_pickup($1, $2)', [
    orderId,
    pickupCode,
  ]);
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
