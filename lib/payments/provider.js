/**
 * PaymentProvider — the only payment interface the application may depend on.
 *
 * The provider question (Hubtel vs Paystack, split settlement vs
 * collect-then-transfer) is still open; see docs/PILOT-QUESTIONS.md. Nothing
 * outside lib/payments/ may assume an answer.
 *
 * Money is always integer pesewas (1 GHS = 100 pesewas). Never floats.
 */
export class PaymentProvider {
  get name() {
    throw new Error('PaymentProvider.name not implemented');
  }

  /**
   * Whether opening a checkout needs the customer's email address.
   *
   * Asked rather than assumed, because the answer decides whether the customer
   * is stopped and asked for one before they can pay. Paystack requires it; the
   * fake provider does not, and making every developer type an address to
   * exercise the order flow would be friction for nothing.
   */
  get requiresCustomerEmail() {
    return false;
  }

  /**
   * Ask the provider to collect money from the customer.
   *
   * MUST be idempotent on `idempotencyKey`: calling twice with the same key
   * returns the same payment, never a second charge.
   *
   * `redirectUrl` on the result is the provider-hosted checkout page. A
   * provider that has one REQUIRES the customer to be sent there — returning it
   * and ignoring it is the same as never having started the payment.
   *
   * @param {object} params
   * @param {string} params.idempotencyKey
   * @param {number} params.amountPesewas server-calculated; never from the client
   * @param {string} params.currency ISO code, "GHS"
   * @param {string} [params.customerPhone] E.164
   * @param {string} [params.customerEmail] a REAL address. Paystack requires
   *        one to open a checkout; it is never synthesised.
   * @param {string} params.reference our internal payment id
   * @param {object} [params.metadata]
   * @returns {Promise<CollectionResult>}
   */
  async initiateCollection(params) {
    throw new Error('PaymentProvider.initiateCollection() not implemented');
  }

  /**
   * Authoritative status read, straight from the provider. Used to reconcile
   * when a webhook is missed, delayed or untrusted.
   * @param {string} providerTransactionId
   * @returns {Promise<{ status: PaymentStatus, amountPesewas: number|null, raw: object }>}
   */
  async getStatus(providerTransactionId) {
    throw new Error('PaymentProvider.getStatus() not implemented');
  }

  /**
   * Verify and normalise an inbound webhook.
   *
   * MUST verify the signature and MUST return a stable `eventId` so the caller
   * can reject replays against the webhook_events table. Returns a normalised
   * event; it must not mutate application state itself.
   *
   * @param {{ rawBody: string, headers: Record<string,string> }} request
   * @returns {Promise<NormalisedWebhookEvent>}
   */
  async handleWebhook(request) {
    throw new Error('PaymentProvider.handleWebhook() not implemented');
  }

  /**
   * Whether this deployment may actually push money out through the provider.
   *
   * A separate question from "is a transfer possible", and it is asked BEFORE
   * anything is created at the provider — so a deployment with transfers off
   * never registers a recipient it is not going to use.
   */
  get canSendTransfers() {
    return true;
  }

  /**
   * Registers a payout destination with the provider, if it has such a concept,
   * and returns the code later transfers refer to.
   *
   * Returns null for a provider that takes an account number directly. The
   * caller stores whatever comes back on the destination row, so a code is
   * created once per destination rather than once per payout.
   *
   * @param {{ momoNetwork: string, accountNumber: string, accountName: string,
   *           currency?: string }} destination
   * @returns {Promise<{ recipientCode: string, raw: object }|null>}
   */
  async ensureTransferRecipient() {
    return null;
  }

  /**
   * Push money out — vendor settlement or Partner payout.
   * MUST be idempotent on `idempotencyKey`.
   *
   * A SUCCEEDED result means the provider ACCEPTED the transfer, not that the
   * money arrived — see hard rule 11. The payout is PROCESSING until a transfer
   * event says otherwise.
   *
   * @param {object} params
   * @param {string} params.idempotencyKey
   * @param {number} params.amountPesewas
   * @param {string} params.currency
   * @param {{ phone?: string, name?: string, channel?: string,
   *           recipientCode?: string, momoNetwork?: string }} params.recipient
   * @param {string} params.reference our internal payout id
   * @param {string} [params.reason] shown to the payee by some providers
   * @returns {Promise<TransferResult>}
   */
  async sendTransfer(params) {
    throw new Error('PaymentProvider.sendTransfer() not implemented');
  }
}

/**
 * Provider-agnostic payment states. These map onto orders.payment_status but
 * are deliberately a separate vocabulary — a provider's states are not our
 * order's states.
 * @typedef {'PENDING'|'SUCCEEDED'|'FAILED'|'CANCELLED'} PaymentStatus
 */

/**
 * @typedef {object} CollectionResult
 * @property {string} providerTransactionId
 * @property {PaymentStatus} status
 * @property {string|null} redirectUrl provider-hosted checkout, when applicable
 * @property {object} raw
 */

/**
 * @typedef {object} TransferResult
 * @property {string} providerTransferId
 * @property {PaymentStatus} status
 * @property {object} raw
 */

/**
 * @typedef {object} NormalisedWebhookEvent
 * @property {string} eventId stable, provider-issued — the idempotency anchor
 * @property {'collection'|'transfer'} kind
 * @property {PaymentStatus} status
 * @property {string} providerTransactionId
 * @property {string|null} reference our internal id, echoed back
 * @property {number|null} amountPesewas
 * @property {boolean} signatureValid
 * @property {object} raw
 */
