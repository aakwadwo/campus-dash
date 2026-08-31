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

function serverOnly(name) {
  if (typeof window !== 'undefined') {
    throw new Error(`${name} is server-only and must never be read in browser code.`);
  }
  return required(name);
}

export const config = {
  // Safe to expose — protected by Row Level Security.
  supabaseUrl: () => required('NEXT_PUBLIC_SUPABASE_URL'),
  supabaseAnonKey: () => required('NEXT_PUBLIC_SUPABASE_ANON_KEY'),

  // Bypasses RLS entirely. Server-side route handlers and jobs only.
  supabaseServiceRoleKey: () => serverOnly('SUPABASE_SERVICE_ROLE_KEY'),

  /**
   * True once Supabase credentials are present. Lets the session proxy skip
   * gracefully during initial setup instead of 500-ing every route; anything
   * that actually touches data still calls the accessors above and fails loudly.
   */
  isSupabaseConfigured: () =>
    Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),

  smsProvider: () => process.env.SMS_PROVIDER || 'fake',
  paymentProvider: () => process.env.PAYMENT_PROVIDER || 'fake',

  isProduction: () => process.env.NODE_ENV === 'production',
};
