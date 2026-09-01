'use client';

import { createBrowserClient } from '@supabase/ssr';
import { config } from '@/lib/config';

/**
 * Supabase client for client components. Uses the anon key, so every query it
 * makes is subject to Row Level Security. Never treat anything it returns as
 * authoritative for money or permissions.
 */
export function createClient() {
  return createBrowserClient(config.supabaseUrl(), config.supabasePublishableKey());
}
