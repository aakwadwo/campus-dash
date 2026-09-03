import { createHmac, timingSafeEqual } from 'node:crypto';

import { PaymentProvider } from './provider.js';

/**
 * PaystackPaymentProvider — hosted redirect checkout, GHS, integer pesewas.
 *
 * The whole of Paystack lives in this file. Nothing outside lib/payments knows
 * that a `reference`, an `authorization_url` or a `transfer_code` exists.
 *
 * MONEY UNITS. Paystack takes and reports GHS amounts in the minor unit, which
 * IS the pesewa. So `amount` crosses this boundary unchanged — no scaling, no
 * division, and no float ever appears. The one guard that matters is currency:
 * an amount that is right as a number and wrong as a currency would otherwise
 * sail through, so a non-GHS transaction reports a null amount and lets
 * confirm_payment() refuse it.
 *
 * IDEMPOTENCY. Paystack has no idempotency-key header; its `reference` is the
 * anchor, and it rejects a reference it has already seen. We pass OUR payment
 * id as the reference, which create_payment_intent() already makes idempotent.
 * So the same tap twice is the same Paystack transaction, and a duplicate
 * rejection is not an error — it means the transaction is already there, and we
 * go and read it.
 */

/** Paystack's Ghana mobile-money bank codes, keyed by our own vocabulary. */
const MOMO_BANK_CODE = {
  MTN: 'MTN',
  // Vodafone Ghana is now Telecel. Paystack still issues the VOD code.
  VODAFONE: 'VOD',
  AIRTELTIGO: 'ATL',
};

/**
 * Provider vocabulary -> ours. Anything unrecognised is PENDING, never
 * SUCCEEDED: an unknown state must not move money.
 */
const TRANSACTION_STATUS = {
  success: 'SUCCEEDED',
  failed: 'FAILED',
  // A reversed CHARGE is money that did not stay with us, so the payment simply
  // failed. (A reversed TRANSFER is a different thing entirely — see below.)
  reversed: 'FAILED',
  abandoned: 'CANCELLED',
  cancelled: 'CANCELLED',
  pending: 'PENDING',
  ongoing: 'PENDING',
  queued: 'PENDING',
  processing: 'PENDING',
};

const TRANSFER_STATUS = {
  success: 'SUCCEEDED',
  failed: 'FAILED',
  // A reversal is NOT a failure. The transfer completed and the money came
  // back, which is a different thing to unwind and a different thing to show
  // somebody investigating. See reverse_payout().
  reversed: 'REVERSED',
  abandoned: 'CANCELLED',
  otp: 'PENDING',
  pending: 'PENDING',
  processing: 'PENDING',
  received: 'PENDING',
};

/** Which of our two kinds an event name belongs to. */
function kindForEvent(event) {
  return String(event ?? '').startsWith('transfer.') ? 'transfer' : 'collection';
}

export class PaystackError extends Error {
  constructor(message, { status = null, code = null, body = null } = {}) {
    super(message);
    this.name = 'PaystackError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export class PaystackPaymentProvider extends PaymentProvider {
  /**
   * Credentials arrive as constructor arguments rather than being read here.
   * That is what keeps the factory the single place the environment is touched,
   * and what makes this class testable against a stub `fetch` with no account.
   */
  constructor({
    secretKey,
    apiUrl = 'https://api.paystack.co',
    callbackUrl = null,
    transfersEnabled = false,
    fetchImpl = globalThis.fetch,
  } = {}) {
    super();
    if (!secretKey) throw new Error('PaystackPaymentProvider requires a secret key');
    this.secretKey = secretKey;
    this.apiUrl = apiUrl.replace(/\/+$/, '');
    this.callbackUrl = callbackUrl;
    this.transfersEnabled = transfersEnabled;
    this.fetchImpl = fetchImpl;
  }

  get name() {
    return 'paystack';
  }

  /** /transaction/initialize will not open a checkout without one. */
  get requiresCustomerEmail() {
    return true;
  }

  // --- HTTP ----------------------------------------------------------------

  /**
   * One place that talks to Paystack.
   *
   * Returns `{ ok, status, body }` rather than throwing on a non-2xx, because
   * several callers need to READ a rejection — a duplicate reference is the
   * obvious one, and treating it as a failure would double-charge people who
   * tap twice.
   */
  async #request(method, path, body) {
    let response;
    try {
      response = await this.fetchImpl(`${this.apiUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      // A network failure is not a payment failure. Say so precisely, so a
      // caller does not record a charge that was never attempted.
      throw new PaystackError(`could not reach Paystack: ${error.message}`);
    }

    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      throw new PaystackError(`Paystack returned a non-JSON response (${response.status})`, {
        status: response.status,
      });
    }

    return { ok: response.ok && parsed?.status === true, status: response.status, body: parsed };
  }

  // --- Collection ----------------------------------------------------------

  /**
   * Opens a hosted checkout and hands back the URL to send the customer to.
   *
   * `reference` is our payment id. `email` is a REAL address the customer gave
   * us — Paystack requires one, and a synthesised address would send every
   * receipt into a hole and put a fiction in our own records.
   */
  async initiateCollection({
    idempotencyKey,
    amountPesewas,
    currency = 'GHS',
    customerEmail,
    reference,
    metadata = {},
  }) {
    if (!idempotencyKey) throw new Error('initiateCollection requires an idempotencyKey');
    if (!reference) throw new Error('initiateCollection requires a reference');
    if (!Number.isInteger(amountPesewas) || amountPesewas <= 0) {
      throw new Error(`amountPesewas must be a positive integer, got ${amountPesewas}`);
    }
    if (currency !== 'GHS') throw new Error(`Paystack is configured for GHS, got ${currency}`);
    if (!customerEmail) {
      throw new Error('initiateCollection requires the customer email address Paystack asks for');
    }

    const { ok, status, body } = await this.#request('POST', '/transaction/initialize', {
      email: customerEmail,
      // Already the minor unit. Nothing to convert.
      amount: amountPesewas,
      currency,
      reference,
      ...(this.callbackUrl ? { callback_url: this.callbackUrl } : {}),
      metadata: { ...metadata, campus_dash_payment_id: reference },
    });

    if (ok) {
      return {
        providerTransactionId: body.data.reference,
        status: 'PENDING',
        redirectUrl: body.data.authorization_url ?? null,
        raw: body.data,
      };
    }

    // Already initialised. That is a retry, not a failure — go and read what
    // the existing transaction is actually doing rather than starting a second.
    if (this.#isDuplicateReference(body)) {
      const existing = await this.getStatus(reference);
      return {
        providerTransactionId: reference,
        status: existing.status,
        redirectUrl: null,
        raw: { ...existing.raw, duplicate_reference: true },
      };
    }

    throw new PaystackError(body?.message ?? `Paystack rejected the initialisation (${status})`, {
      status,
      body,
    });
  }

  /**
   * Paystack words this differently for transactions and transfers, so match
   * on the part that is stable rather than on either exact sentence.
   */
  #isDuplicateReference(body) {
    const message = String(body?.message ?? '');
    return /duplicate/i.test(message) && /reference/i.test(message);
  }

  /**
   * What Paystack believes about one transfer, by our reference.
   *
   * Used only to resolve a duplicate-reference rejection safely. A null
   * providerTransferId means they cannot describe it, which the caller must
   * treat as "do not reuse this reference" rather than as a recoverable error.
   */
  async getTransferStatus(reference) {
    const { ok, status, body } = await this.#request(
      'GET',
      `/transfer/verify/${encodeURIComponent(reference)}`
    );

    if (!ok) {
      return {
        providerTransferId: null,
        status: 'PENDING',
        raw: { error: body?.message ?? `transfer verify failed (${status})` },
      };
    }

    return {
      providerTransferId: body.data.transfer_code ?? null,
      status: TRANSFER_STATUS[body.data.status] ?? 'PENDING',
      raw: body.data,
    };
  }

  /**
   * The authoritative read. Keyed by reference, which is our payment id — the
   * one identifier that exists from the moment we create the payment, unlike
   * Paystack's numeric transaction id, which only appears once someone pays.
   */
  async getStatus(providerTransactionId) {
    const { ok, status, body } = await this.#request(
      'GET',
      `/transaction/verify/${encodeURIComponent(providerTransactionId)}`
    );

    if (!ok) {
      // A transaction Paystack cannot describe is a finding, not a success.
      return {
        status: 'FAILED',
        amountPesewas: null,
        raw: { error: body?.message ?? `verify failed (${status})` },
      };
    }

    return {
      status: TRANSACTION_STATUS[body.data.status] ?? 'PENDING',
      amountPesewas: this.#amountFor(body.data),
      raw: body.data,
    };
  }

  /**
   * An amount is only an amount if the currency is the one we asked for.
   * Returning null for anything else makes confirm_payment() refuse it, which
   * is exactly the right outcome: a mismatch is a reconciliation incident.
   */
  #amountFor(data) {
    if (data?.currency && data.currency !== 'GHS') {
      console.error(
        `[paystack] transaction ${data.reference} is in ${data.currency}, not GHS — refusing the amount`
      );
      return null;
    }
    return Number.isInteger(data?.amount) ? data.amount : null;
  }

  // --- Webhooks ------------------------------------------------------------

  /**
   * Verifies and normalises one inbound event.
   *
   * The signature is HMAC-SHA512 of the EXACT bytes received, keyed by the
   * secret key. So the raw body is what gets hashed — re-serialising the parsed
   * object would change whitespace and fail every time.
   *
   * Paystack sends no event id of its own, so one is derived from the event
   * name and the object's own id. That pair is stable across the retries
   * Paystack makes, which is all webhook_events needs to deduplicate on.
   */
  async handleWebhook({ rawBody, headers = {} }) {
    const payload = JSON.parse(rawBody);
    const signatureValid = this.verifySignature(rawBody, headers['x-paystack-signature']);

    const event = String(payload?.event ?? '');
    const data = payload?.data ?? {};
    const kind = kindForEvent(event);

    if (kind === 'transfer') {
      // The event NAME decides a reversal, not data.status: mistaking a
      // reversal for a success would leave money recorded as delivered that
      // has actually come back.
      const transferStatus =
        event === 'transfer.reversed'
          ? 'REVERSED'
          : (TRANSFER_STATUS[data.status] ?? (event === 'transfer.failed' ? 'FAILED' : 'PENDING'));

      return {
        eventId: this.#eventId(event, data.id ?? data.transfer_code ?? data.reference),
        kind: 'transfer',
        status: transferStatus,
        // The transfer code is what later events and lookups agree on; the
        // numeric id is not echoed everywhere.
        providerTransactionId: data.transfer_code ?? null,
        // Our own payout id, handed to them when the transfer was created.
        reference: data.reference ?? null,
        amountPesewas: this.#amountFor(data),
        signatureValid,
        raw: payload,
      };
    }

    return {
      eventId: this.#eventId(event, data.id ?? data.reference),
      kind: 'collection',
      status: TRANSACTION_STATUS[data.status] ?? (event === 'charge.failed' ? 'FAILED' : 'PENDING'),
      // The reference is our payment id, and it is also what getStatus() reads,
      // so both paths attach the SAME provider transaction id to the payment.
      providerTransactionId: data.reference ?? null,
      reference: data.reference ?? null,
      amountPesewas: this.#amountFor(data),
      signatureValid,
      raw: payload,
    };
  }

  #eventId(event, id) {
    return `${event || 'unknown'}:${id ?? 'unknown'}`;
  }

  /**
   * Timing-safe comparison, and false for anything malformed.
   *
   * A missing or wrong-length header must read as "not verified" rather than
   * throwing: processPaymentWebhook still wants to RECORD the attempt, flagged,
   * so an attacker probing the endpoint leaves a trail instead of a 500.
   */
  verifySignature(rawBody, signature) {
    if (typeof signature !== 'string' || signature.length === 0) return false;

    const expected = createHmac('sha512', this.secretKey).update(rawBody, 'utf8').digest('hex');
    const given = signature.trim().toLowerCase();
    if (given.length !== expected.length) return false;

    return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(given, 'utf8'));
  }

  // --- Transfers -----------------------------------------------------------

  /** False until somebody funds the balance and turns transfers on. */
  get canSendTransfers() {
    return this.transfersEnabled;
  }

  /**
   * Creates the Paystack recipient for a payout destination.
   *
   * Separate from sendTransfer because the recipient_code outlives any one
   * transfer and belongs on the destination row — creating a fresh recipient
   * per payout would litter the account and lose the link between a code and
   * the number a person actually checked.
   */
  async ensureTransferRecipient({ momoNetwork, accountNumber, accountName, currency = 'GHS' }) {
    const bankCode = MOMO_BANK_CODE[momoNetwork];
    if (!bankCode) {
      throw new Error(
        `unsupported mobile money network "${momoNetwork}". Paystack Ghana supports ${Object.keys(MOMO_BANK_CODE).join(', ')}.`
      );
    }

    const { ok, status, body } = await this.#request('POST', '/transferrecipient', {
      type: 'mobile_money',
      name: accountName,
      account_number: accountNumber,
      bank_code: bankCode,
      currency,
    });

    if (!ok) {
      throw new PaystackError(body?.message ?? `could not create a recipient (${status})`, {
        status,
        body,
      });
    }

    return { recipientCode: body.data.recipient_code, raw: body.data };
  }

  /**
   * Pushes money out.
   *
   * Guarded by transfersEnabled, which is false unless somebody deliberately
   * turned it on. Collection can be switched on the moment the keys exist;
   * transfers cannot, because they need a funded balance, transfers approved on
   * the Paystack account, and destinations a person has actually checked.
   * Refusing here — rather than in the caller — means there is exactly one place
   * that can start a real-money transfer, and it is closed by default.
   */
  async sendTransfer({
    idempotencyKey,
    amountPesewas,
    currency = 'GHS',
    recipient,
    reference,
    reason,
  }) {
    if (!idempotencyKey) throw new Error('sendTransfer requires an idempotencyKey');
    if (!Number.isInteger(amountPesewas) || amountPesewas <= 0) {
      throw new Error(`amountPesewas must be a positive integer, got ${amountPesewas}`);
    }
    if (currency !== 'GHS') throw new Error(`Paystack is configured for GHS, got ${currency}`);

    if (!this.transfersEnabled) {
      throw new PaystackError(
        'Paystack transfers are switched off on this deployment. Set PAYSTACK_TRANSFERS_ENABLED=true once the balance is funded, transfers are approved on the Paystack account, and the payout destination has been checked.',
        { code: 'transfers_disabled' }
      );
    }

    if (!recipient?.recipientCode) {
      throw new PaystackError(
        'this payee has no Paystack recipient yet — set a mobile money destination first',
        { code: 'no_recipient' }
      );
    }

    const { ok, status, body } = await this.#request('POST', '/transfer', {
      source: 'balance',
      amount: amountPesewas,
      currency,
      recipient: recipient.recipientCode,
      // Our payout id, echoed back on the transfer webhook.
      reference,
      reason: reason ?? 'Campus Dash settlement',
    });

    if (!ok) {
      // Paystack has seen this reference before, which means a transfer for it
      // may ALREADY EXIST. The one thing we must not do is send another. Read
      // what is actually there instead.
      if (this.#isDuplicateReference(body)) {
        const existing = await this.getTransferStatus(reference);
        if (existing.providerTransferId) {
          return { ...existing, raw: { ...existing.raw, duplicate_reference: true } };
        }
        throw new PaystackError(
          `Paystack reports reference ${reference} as a duplicate but cannot describe it; this reference must not be reused`,
          { status, body, code: 'duplicate_reference_unresolved' }
        );
      }

      throw new PaystackError(body?.message ?? `Paystack refused the transfer (${status})`, {
        status,
        body,
      });
    }

    return {
      providerTransferId: body.data.transfer_code,
      // 'otp' or 'pending' here; PROCESSING on our side either way. Only
      // transfer.success makes a payout PAID.
      status: TRANSFER_STATUS[body.data.status] ?? 'PENDING',
      raw: body.data,
    };
  }
}

export { MOMO_BANK_CODE };
