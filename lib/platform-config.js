import 'server-only';

import { createClient } from '@/lib/supabase/server';

/**
 * Platform configuration, read from the database.
 *
 * Everything the pilot is likely to argue about — fees, timeouts, poll
 * cadences, retention — lives in one row an admin can edit without a deploy.
 * Nothing outside this module hard-codes those numbers.
 *
 * Cached per request only. A config change must take effect on the next page
 * load, not on the next restart, so there is deliberately no long-lived cache.
 */

/** Used when the database cannot be reached, so a screen degrades rather than 500s. */
const FALLBACK = Object.freeze({
  service_fee_pesewas: 200,
  delivery_fee_pesewas: 500,
  vendor_response_seconds: 60,
  partner_search_seconds: 600,
  customer_absent_wait_seconds: 300,
  payment_pending_timeout_seconds: 900,
  min_payout_pesewas: 0,
  approved_document_retention_days: 90,
  rejected_document_retention_days: 30,
  document_signed_url_seconds: 120,
  notification_retry_limit: 2,
  vendor_poll_seconds: 8,
  partner_poll_seconds: 10,
  customer_poll_seconds: 6,
});

export async function getPlatformConfig() {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc('platform_config');
    if (error) throw new Error(error.message);
    return { ...FALLBACK, ...(Array.isArray(data) ? data[0] : data) };
  } catch (error) {
    console.error('[config] falling back to defaults:', error.message);
    return FALLBACK;
  }
}

/** Milliseconds, for the browser. Screens take these as props rather than guessing. */
export async function getPollIntervals() {
  const config = await getPlatformConfig();
  return {
    vendorMs: config.vendor_poll_seconds * 1000,
    partnerMs: config.partner_poll_seconds * 1000,
    customerMs: config.customer_poll_seconds * 1000,
  };
}

export { FALLBACK as CONFIG_DEFAULTS };
