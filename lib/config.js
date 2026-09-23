/**
 * Central environment access.
 *
 * Rule: nothing outside this module reads `process.env` directly. That keeps
 * every credential in one auditable place and makes it obvious which values are
 * server-only.
 */

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. Copy .env.example to .env.local and fill it in.`
    );
  }
  return value;
}

/**
 * A credential that must never be read in browser code.
 *
 * The window check is the point: if a client component ever pulls one of these
 * in, the build fails loudly here rather than shipping a live key to every
 * visitor.
 *
 * `optional` is for secrets whose absence is a legitimate state the caller
 * handles — a webhook verifier with no secret configured must reject every
 * request, which is a very different thing from crashing the process.
 */
function serverOnly(name, { optional = false } = {}) {
  if (typeof window !== 'undefined') {
    throw new Error(`${name} is server-only and must never be read in browser code.`);
  }
  return optional ? (process.env[name] ?? null) : required(name);
}

/**
 * Supabase's project URL is the bare origin — https://<ref>.supabase.co — and
 * the client libraries append /rest/v1, /auth/v1 and /storage/v1 themselves.
 * Pasting the REST endpoint out of the dashboard instead is an easy mistake and
 * a miserable one to debug: every request 404s or 401s from a URL that looks
 * correct. Trim it here rather than letting each caller discover it.
 */
function supabaseOrigin() {
  const raw = required('NEXT_PUBLIC_SUPABASE_URL').trim();
  return raw.replace(/\/(rest|auth|storage|realtime)\/v1\/?$/, '').replace(/\/+$/, '');
}

export const config = {
  supabaseUrl: supabaseOrigin,

  /**
   * The publishable key. Safe to expose: every query it makes is subject to Row
   * Level Security, and clients hold SELECT only.
   *
   * Supabase renamed this key. New projects issue `sb_publishable_…` and call it
   * the publishable key; older ones issue a JWT and call it the anon key. They
   * occupy the same slot, so the old name is still accepted — but only as a
   * fallback, so there is one name in the code and in the docs.
   */
  supabasePublishableKey: () =>
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || required('NEXT_PUBLIC_SUPABASE_ANON_KEY'),

  // Bypasses RLS entirely. Server-side route handlers and jobs only.
  supabaseServiceRoleKey: () => serverOnly('SUPABASE_SERVICE_ROLE_KEY'),

  /**
   * True once Supabase credentials are present. Lets the session proxy skip
   * gracefully during initial setup instead of 500-ing every route; anything
   * that actually touches data still calls the accessors above and fails loudly.
   */
  isSupabaseConfigured: () =>
    Boolean(
      process.env.NEXT_PUBLIC_SUPABASE_URL &&
      (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
    ),

  smsProvider: () => process.env.SMS_PROVIDER || 'fake',
  paymentProvider: () => process.env.PAYMENT_PROVIDER || 'fake',
  emailProvider: () => process.env.EMAIL_PROVIDER || 'fake',

  // --- Arkesel -------------------------------------------------------------
  // All three are SERVER ONLY. The API key is a bearer credential for an
  // account with real money in it: anyone holding it can send SMS at our cost.
  // serverOnly() throws rather than returning if browser code ever reaches for
  // one, so a mistaken import fails loudly instead of shipping a key.
  arkeselApiKey: () => serverOnly('ARKESEL_API_KEY'),

  // Optional on purpose: a missing secret must read as "cannot verify", which
  // makes the webhook reject everything. Never as "verified".
  arkeselWebhookSecret: () => serverOnly('ARKESEL_WEBHOOK_SECRET', { optional: true }),

  /**
   * Same shape, and the same reason — the Send SMS Hook rejects when unset.
   *
   * Supabase names this setting in the plural and supports rotation, so the
   * value may be several space-separated secrets. SEND_SMS_HOOK_SECRETS is the
   * name their current documentation uses; the singular is still read so an
   * existing .env keeps working.
   */
  sendSmsHookSecret: () =>
    serverOnly('SEND_SMS_HOOK_SECRETS', { optional: true }) ??
    serverOnly('SEND_SMS_HOOK_SECRET', { optional: true }),

  // Not a secret, but not hard-coded either: the sender ID is registered with
  // Arkesel per account and differs between a test and a live sender.
  arkeselSenderId: () => required('ARKESEL_SENDER_ID'),

  // The verified v1 endpoint. Overridable so a sandbox can be pointed at
  // without a code change.
  arkeselSmsUrl: () => process.env.ARKESEL_SMS_URL || 'https://sms.arkesel.com/sms/api',

  // --- Email ---------------------------------------------------------------
  //
  // OPERATIONAL MAIL ONLY. Customers, vendors and Partners are reached by SMS,
  // and sign-in codes come from Supabase Auth's own mailer. This is for telling
  // the people running the pilot that something happened to the platform.

  /**
   * SERVER ONLY. A bearer credential for an account that can send mail at our
   * cost, under our domain — so it is worth as much to somebody else as the
   * Arkesel key is. serverOnly() throws rather than returning if browser code
   * ever reaches for it.
   */
  resendApiKey: () => serverOnly('RESEND_API_KEY'),

  /**
   * The From address, and it needs no setup.
   *
   * The default is Resend's shared onboarding sender, which requires no domain
   * and no verification — so the entire configuration for real email is an API
   * key. The one string attached: that sender may only deliver to the address
   * the Resend account itself was created with, and anything else is a 403. For
   * a pilot notifying one person that is not a limitation, it is the setup.
   *
   * Override it only once a real domain is verified on the account.
   */
  emailFromAddress: () => process.env.EMAIL_FROM_ADDRESS || 'Campus Dash <onboarding@resend.dev>',

  /**
   * Where operational notifications go.
   *
   * Deliberately its own variable rather than an administrator's sign-in
   * address. Those are CREDENTIALS — the thing an admin proves themselves with
   * — and a mailing list is a different concern that should be changeable
   * without touching who can sign in. Optional: a deployment that has not set
   * one simply sends no operational mail, which is a quiet deployment rather
   * than a broken one.
   */
  adminNotificationEmail: () => process.env.ADMIN_NOTIFICATION_EMAIL?.trim() || null,

  // --- Paystack ------------------------------------------------------------
  // SERVER ONLY, and the more dangerous of the two by a distance: the secret
  // key both moves money and SIGNS the webhooks we authenticate. Anyone holding
  // it can charge cards, send transfers, and forge an event that marks an order
  // paid. serverOnly() throws rather than returning if browser code ever
  // reaches for it.
  paystackSecretKey: () => serverOnly('PAYSTACK_SECRET_KEY'),

  /**
   * The public key is server-only here too, and deliberately so.
   *
   * It is not a secret — but we use HOSTED REDIRECT checkout, where the browser
   * never talks to Paystack directly, so nothing client-side needs it. Giving
   * it a NEXT_PUBLIC_ prefix would inline a key into every page for no reason
   * and invite an inline-checkout path that bypasses the server. Optional,
   * because nothing on the payment path actually requires it.
   */
  paystackPublicKey: () => serverOnly('PAYSTACK_PUBLIC_KEY', { optional: true }),

  // Overridable so a proxy or a recorded fixture can stand in during testing.
  paystackApiUrl: () =>
    (process.env.PAYSTACK_API_URL || 'https://api.paystack.co').replace(/\/+$/, ''),

  /**
   * Whether this deployment may actually push money OUT through Paystack.
   *
   * Defaults to false, and stays false until a human turns it on. Collection is
   * safe to enable the moment the keys exist — the worst case is a test charge.
   * Transfers are not: they need a funded balance, a Paystack account with
   * transfers approved, and payout destinations that have been checked by a
   * person. Until then sendTransfer() refuses, the payout is recorded FAILED,
   * and the allocation goes back into the next run.
   */
  paystackTransfersEnabled: () => process.env.PAYSTACK_TRANSFERS_ENABLED === 'true',

  /**
   * Whether a charge may be split to a vendor's subaccount at collection time.
   *
   * ON by default, unlike transfers, and for the opposite reason. A split does
   * not push money anywhere — it tells Paystack to route the vendor's own food
   * money to the vendor's own account instead of parking it in ours, which is
   * the arrangement the vendor agreed to. Nothing is at risk that was not
   * already at risk when they set the account up.
   *
   * The switch exists because multi-split has to be enabled on a Paystack
   * account, and a deployment whose account does not have it should be able to
   * turn the attempt off rather than log a refusal on every order.
   */
  paystackSplitEnabled: () => process.env.PAYSTACK_SPLIT_ENABLED !== 'false',

  /**
   * Public origin of this deployment. Two callers, two different consequences
   * when it is missing:
   *
   *   Arkesel — builds the delivery-report URL. Without it, sending still works
   *   and we simply never learn the outcome.
   *
   *   Paystack — builds the checkout return URL. Without it, Paystack falls
   *   back to whatever callback is configured on the dashboard, which for a
   *   preview deployment is the wrong origin entirely. Set it.
   */
  publicAppUrl: () => process.env.PUBLIC_APP_URL?.replace(/\/+$/, '') || null,

  /**
   * THE CANONICAL ORIGIN, for everything a search engine or a social card reads.
   *
   * Distinct from publicAppUrl() on purpose. That one may legitimately be null —
   * a preview deployment, a local run — and callers handle that. This one never
   * is, because a canonical URL that is absent or that points at a preview host
   * is worse than one that is merely stale: it either leaves search engines to
   * guess, or it tells them the preview is the real thing.
   *
   * So a preview's own origin is never canonical. Vercel gives every deployment
   * a unique *.vercel.app hostname, and letting one of those become canonical is
   * how a staging URL ends up in search results outranking the real site.
   */
  canonicalOrigin: () => {
    const configured = process.env.PUBLIC_APP_URL?.replace(/\/+$/, '');
    if (configured && !/\.vercel\.app$/i.test(new URL(configured).hostname)) return configured;
    // The bare domain is primary; www only redirects to it.
    return 'https://campusdash.app';
  },

  /**
   * Which canonical form Arkesel signs. See lib/sms/arkesel-webhook.js — their
   * published documentation does not state it, so it is configurable rather
   * than guessed at in code.
   */
  arkeselWebhookScheme: () => process.env.ARKESEL_WEBHOOK_SCHEME || 'timestamp.body:hex',

  /**
   * Which credentials are present, and nothing about what they are.
   *
   * /api/health needs to answer "is this deployment configured?" without
   * becoming the one endpoint that echoes a secret. Booleans only, and it lives
   * here so that reading the environment stays in one auditable file.
   */
  presence: () => ({
    supabaseUrl: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL),
    supabasePublishableKey: Boolean(
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    ),
    supabaseServiceRoleKey: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    arkeselApiKey: Boolean(process.env.ARKESEL_API_KEY),
    arkeselSenderId: Boolean(process.env.ARKESEL_SENDER_ID),
    arkeselWebhookSecret: Boolean(process.env.ARKESEL_WEBHOOK_SECRET),
    paystackSecretKey: Boolean(process.env.PAYSTACK_SECRET_KEY),
    paystackPublicKey: Boolean(process.env.PAYSTACK_PUBLIC_KEY),
    paystackTransfersEnabled: process.env.PAYSTACK_TRANSFERS_ENABLED === 'true',
    paystackSplitEnabled: process.env.PAYSTACK_SPLIT_ENABLED !== 'false',
    publicAppUrl: Boolean(process.env.PUBLIC_APP_URL),
    resendApiKey: Boolean(process.env.RESEND_API_KEY),
    adminNotificationEmail: Boolean(process.env.ADMIN_NOTIFICATION_EMAIL),
  }),

  isProduction: () => process.env.NODE_ENV === 'production',
};
