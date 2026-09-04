import { NextResponse } from 'next/server';
import { uploadVerificationDocument, uploadScan } from '@/lib/verification/documents';

export const dynamic = 'force-dynamic';

/**
 * Receives one verification image from the signed-in account.
 *
 * Three callers, three kinds:
 *   student-id  student onboarding, where the CUSTOMER capability is granted
 *   face        the Partner application, which adds exactly this one document
 *   scan        a campus meal scan, which goes to its own private bucket and
 *               is later released to one assigned Partner for one errand
 *
 * The face photograph arrives as a blob captured from the device camera — that
 * form offers no file picker, deliberately, because the point is a LIVE
 * photograph an admin can compare against the ID.
 *
 * That constraint is enforced in the browser and cannot be enforced here. A
 * determined applicant can always POST whatever they like; the real control is
 * the human review, which is why Partner approval is manual.
 */
export async function POST(request) {
  try {
    const form = await request.formData();
    const kind = String(form.get('kind') ?? '');
    const file = form.get('file');

    if (!file || typeof file === 'string') {
      return NextResponse.json({ error: 'No image was received.' }, { status: 400 });
    }

    // A scan is a different artifact in a different bucket, so it takes a
    // different path home. The response carries the type and size because
    // submit_scan_order() records both, and the browser must not be the one
    // that decides them.
    if (kind === 'scan') {
      const scan = await uploadScan({ file });
      return NextResponse.json(scan);
    }

    const { path } = await uploadVerificationDocument({ kind, file });
    return NextResponse.json({ path });
  } catch (error) {
    // Detail stays in the log; the person gets something they can act on.
    console.error('[verification-documents] upload failed:', error.message);
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}
