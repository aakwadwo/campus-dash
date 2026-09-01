import { NextResponse } from 'next/server';
import { processSmsWebhook } from '@/lib/sms/webhook';

export const dynamic = 'force-dynamic';

/**
 * SMS delivery reports.
 *
 * Public by necessity — a provider cannot sign in. The signature IS the
 * authentication, which is why processSmsWebhook verifies before it trusts
 * anything, including the query string.
 *
 * Both verbs are served because Arkesel's callback has appeared as a GET
 * carrying sms_id and status in the query, and as a signed POST with a JSON
 * body. The signed bytes are whichever of those actually carried the data.
 */
async function handle(request, { params }) {
  const { provider } = await params;
  const url = new URL(request.url);
  const rawBody = request.method === 'POST' ? await request.text() : '';

  const { status, body } = await processSmsWebhook({
    provider,
    rawBody,
    searchParams: url.searchParams,
    headers: request.headers,
  });

  return NextResponse.json(body, { status });
}

export const GET = handle;
export const POST = handle;
