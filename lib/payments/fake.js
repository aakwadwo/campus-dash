import { PaymentProvider } from './provider';

/**
 * FakePaymentProvider — development only.
 *
 * Behaves like a real asynchronous provider: a collection starts PENDING,
 * "processes" for ~2 seconds, then succeeds and emits a webhook-shaped event
 * with a fake provider transaction id. That means the order/payment state
 * machine is exercised for real, including the pending window, rather than
 * short-circuiting to PAID.
 *
 * In-memory state is intentional: it is a stand-in for the provider's records,
 * not ours. Our own records live in the `payments` table.
 */
const PROCESSING_DELAY_MS = 2000;

export class FakePaymentProvider extends PaymentProvider {
  constructor() {
    super();
    /** @type {Map<string, object>} keyed by providerTransactionId */
    this.transactions = new Map();
    /** @type {Map<string, string>} idempotencyKey -> providerTransactionId */
    this.idempotency = new Map();
  }

  get name() {
    return 'fake';
  }

  async initiateCollection({
    idempotencyKey,
    amountPesewas,
    currency = 'GHS',
    customerPhone,
    customerEmail,
    reference,
    metadata = {},
  }) {
    if (!idempotencyKey) throw new Error('initiateCollection requires an idempotencyKey');
    if (!Number.isInteger(amountPesewas) || amountPesewas <= 0) {
      throw new Error(`amountPesewas must be a positive integer, got ${amountPesewas}`);
    }

    // Idempotency: the same key never produces a second charge.
    const existingId = this.idempotency.get(idempotencyKey);
    if (existingId) {
      const existing = this.transactions.get(existingId);
      return {
        providerTransactionId: existing.id,
        status: existing.status,
        redirectUrl: null,
        raw: { ...existing, replayed: true },
      };
    }

    const id = `fake_txn_${crypto.randomUUID()}`;
    const txn = {
      id,
      kind: 'collection',
      status: 'PENDING',
      amountPesewas,
      currency,
      customerPhone,
      customerEmail,
      reference,
      metadata,
      createdAt: new Date().toISOString(),
    };

    this.transactions.set(id, txn);
    this.idempotency.set(idempotencyKey, id);
    this.#scheduleSuccess(id);

    console.log(`[fake-payment] collection ${id} PENDING — ${amountPesewas}p ref=${reference}`);

    return { providerTransactionId: id, status: 'PENDING', redirectUrl: null, raw: { ...txn } };
  }

  async getStatus(providerTransactionId) {
    const txn = this.transactions.get(providerTransactionId);
    if (!txn) {
      return { status: 'FAILED', amountPesewas: null, raw: { error: 'unknown_transaction' } };
    }
    return { status: txn.status, amountPesewas: txn.amountPesewas, raw: { ...txn } };
  }

  /**
   * The fake provider signs webhooks with a fixed marker rather than a real
   * HMAC. The important part is that callers still go through signature
   * verification, so wiring a real provider changes this method only.
   */
  async handleWebhook({ rawBody, headers = {} }) {
    const payload = JSON.parse(rawBody);
    const signatureValid = headers['x-fake-signature'] === 'fake-signature';

    return {
      eventId: payload.eventId,
      kind: payload.kind ?? 'collection',
      status: payload.status,
      providerTransactionId: payload.providerTransactionId,
      reference: payload.reference ?? null,
      amountPesewas: payload.amountPesewas ?? null,
      signatureValid,
      raw: payload,
    };
  }

  async sendTransfer({ idempotencyKey, amountPesewas, currency = 'GHS', recipient, reference }) {
    if (!idempotencyKey) throw new Error('sendTransfer requires an idempotencyKey');
    if (!Number.isInteger(amountPesewas) || amountPesewas <= 0) {
      throw new Error(`amountPesewas must be a positive integer, got ${amountPesewas}`);
    }

    const existingId = this.idempotency.get(idempotencyKey);
    if (existingId) {
      const existing = this.transactions.get(existingId);
      return {
        providerTransferId: existing.id,
        status: existing.status,
        raw: { ...existing, replayed: true },
      };
    }

    const id = `fake_transfer_${crypto.randomUUID()}`;
    const txn = {
      id,
      kind: 'transfer',
      status: 'PENDING',
      amountPesewas,
      currency,
      recipient,
      reference,
      createdAt: new Date().toISOString(),
    };

    this.transactions.set(id, txn);
    this.idempotency.set(idempotencyKey, id);
    this.#scheduleSuccess(id);

    console.log(
      `[fake-payment] transfer ${id} PENDING — ${amountPesewas}p to ${recipient?.accountNumber ?? recipient?.phone ?? 'unknown'}`
    );

    return { providerTransferId: id, status: 'PENDING', raw: { ...txn } };
  }

  /** Simulates the provider taking ~2s to settle, then emitting an event. */
  #scheduleSuccess(id) {
    const timer = setTimeout(() => {
      const txn = this.transactions.get(id);
      if (!txn || txn.status !== 'PENDING') return;

      txn.status = 'SUCCEEDED';
      txn.completedAt = new Date().toISOString();
      txn.eventId = `fake_evt_${crypto.randomUUID()}`;

      console.log(`[fake-payment] ${txn.kind} ${id} SUCCEEDED — event ${txn.eventId}`);
    }, PROCESSING_DELAY_MS);

    // Do not hold the Node process open in tests or scripts.
    if (typeof timer.unref === 'function') timer.unref();
  }

  /**
   * Test/dev helper: build the webhook body the provider *would* have posted.
   * Used by the dev-only webhook simulator route so the real webhook handler is
   * the code path under test.
   */
  buildWebhookPayload(providerTransactionId) {
    const txn = this.transactions.get(providerTransactionId);
    if (!txn) return null;
    return {
      eventId: txn.eventId ?? `fake_evt_${providerTransactionId}`,
      kind: txn.kind,
      status: txn.status,
      providerTransactionId: txn.id,
      reference: txn.reference ?? null,
      amountPesewas: txn.amountPesewas,
    };
  }
}
