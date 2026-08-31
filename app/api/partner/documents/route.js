import { NextResponse } from 'next/server';
import { uploadPartnerDocument } from '@/lib/partner/documents';

export const dynamic = 'force-dynamic';

/**
 * Receives one verification image from the Partner application form.
 *
 * The face photograph arrives here as a blob captured from the device camera —
 * the form offers no file picker for it, deliberately, because the point is a
 * LIVE photograph an admin can compare against the ID.
 *
 * That constraint is enforced in the browser and cannot be. A determined
 * applicant can always POST whatever they like; the real control is the human
 * review, which is why Partner approval is manual.
 */
export async function POST(request) {
  try {
    const form = await request.formData();
    const kind = String(form.get('kind') ?? '');
    const file = form.get('file');

    if (!file || typeof file === 'string') {
      return NextResponse.json({ error: 'No image was received.' }, { status: 400 });
    }

    const { path } = await uploadPartnerDocument({ kind, file });
    return NextResponse.json({ path });
  } catch (error) {
    // Detail stays in the log; the applicant gets something they can act on.
    console.error('[partner-documents] upload failed:', error.message);
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}
