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

  /**
   * Public origin of this deployment, used to build the delivery callback URL
   * we hand to Arkesel. Without it we simply do not ask for delivery reports —
   * sending still works, we just never learn the outcome.
   */
  publicAppUrl: () => process.env.PUBLIC_APP_URL?.replace(/\/+$/, '') || null,

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
    publicAppUrl: Boolean(process.env.PUBLIC_APP_URL),
  }),

  isProduction: () => process.env.NODE_ENV === 'production',
};
