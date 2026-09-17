import { NextResponse } from 'next/server';
import { uploadVerificationDocument, uploadScan } from '@/lib/verification/documents';
import { toUserError } from '@/lib/errors';

export const dynamic = 'force-dynamic';

/**
 * Receives one verification image from the signed-in account.
 *
 * Two kinds:
 *   student-id  the Partner application's one document
 *   scan        a campus meal scan, which goes to its own private bucket and
 *               is later released to one assigned Partner for one errand
 *
 * Either may arrive as a file the person chose or as a blob captured from the
 * device camera. This endpoint cannot tell the difference and does not try:
 * for a student ID the control is that an administrator reads the application,
 * and for a scan it is that only the customer and one assigned Partner can ever
 * fetch it back.
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
    //
    // THROUGH toUserError(), not straight out. Half of what this can throw is
    // ours and written for a person — "Please use a JPEG, PNG or WebP image."
    // — and the other half is a storage client's own text, which has no place
    // in a response. The one vetting list decides which is which, and it also
    // decides the status: a file that is too large is the caller's to fix, a
    // storage outage is not.
    const { message, status } = toUserError(error, 'document upload');
    return NextResponse.json({ error: message }, { status });
  }
}
