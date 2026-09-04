import { NextResponse } from 'next/server';
import { uploadVerificationDocument } from '@/lib/verification/documents';

export const dynamic = 'force-dynamic';

/**
 * Receives one verification image from the signed-in account.
 *
 * Two callers, two kinds:
 *   student-id  student onboarding, where the CUSTOMER capability is granted
 *   face        the Partner application, which adds exactly this one document
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

    const { path } = await uploadVerificationDocument({ kind, file });
    return NextResponse.json({ path });
  } catch (error) {
    // Detail stays in the log; the person gets something they can act on.
    console.error('[verification-documents] upload failed:', error.message);
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}
