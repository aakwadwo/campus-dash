'use client';

import Link from 'next/link';
import { useActionState, useEffect, useRef, useState } from 'react';
import CameraCapture from '@/app/camera-capture';
import { applyAction } from '../actions';

/**
 * Becoming a Partner.
 *
 * THIS FORM ASKS FOR ONE DOCUMENT, and what it does NOT ask for is the point.
 *
 * A Partner already holds the CUSTOMER capability — the database refuses this
 * application without it — which means a verified @acity.edu.gh address has
 * already established who this is. Name, student ID number and level are on the
 * account. Re-asking would imply a second identity is being created, which is
 * exactly the confusion this flow exists to avoid.
 *
 * There is also no face photograph any more. It proved nothing the school
 * address had not already proved, and it was the most sensitive thing Campus
 * Dash was storing. What remains is the student ID card, the Partner terms, and
 * a person at Campus Dash reading the application.
 */
export default function ApplyForm({ profile }) {
  const [state, submit, submitting] = useActionState(applyAction, {});
  const [idPath, setIdPath] = useState('');

  // The form is REPLACED on success. Leaving a filled-in form on screen under a
  // success message reads as "nothing happened" and invites a second submission
  // — which partner_apply() would accept, resetting the review clock.
  if (state.submitted) {
    return (
      <section className="mt-6 space-y-4">
        <div className="rounded-card bg-surface border-line border p-5">
          <h2 className="text-base font-semibold">Application received</h2>
          <p className="text-muted mt-2 text-sm leading-relaxed">
            Someone at Campus Dash will read it and let you know. It is reviewed by hand, so it is
            not instant.
          </p>
        </div>
        <ContinueOrdering />
      </section>
    );
  }

  return (
    <form action={submit} className="mt-6 space-y-6">
      <input type="hidden" name="student_id_image_path" value={idPath} />

      {/* Read-only, and shown rather than re-asked: seeing it here is how an
          applicant understands that the same account is being upgraded rather
          than a second one created. */}
      <section className="rounded-card bg-surface border-line border p-4">
        <h2 className="text-sm font-medium">Your student details</h2>
        <p className="text-muted mt-1 text-xs">
          Already on your account, from when you signed up. Your school email is verified, so
          nothing here needs checking again.
        </p>
        <dl className="mt-3 space-y-1.5 text-sm">
          <Row label="Student ID" value={profile?.student_id_number} />
          <Row label="Level" value={profile?.level} />
        </dl>
      </section>

      <StudentIdUpload path={idPath} onUploaded={setIdPath} />

      {state.message ? (
        <p
          role={state.ok ? 'status' : 'alert'}
          className={`text-sm ${state.ok ? 'text-good' : 'text-bad'}`}
        >
          {state.message}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={submitting || !idPath}
        className="press bg-brand-700 hover:bg-brand-800 w-full rounded-full py-4 text-base font-semibold text-white transition-colors disabled:opacity-55"
      >
        {submitting ? 'Submitting…' : 'Submit application'}
      </button>
      <p className="text-muted text-center text-xs">
        By applying you agree to the Campus Dash Partner terms.
      </p>
    </form>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className="font-medium">{value ?? '-'}</dd>
    </div>
  );
}

/**
 * A Partner is also a customer on the SAME account — capabilities are additive
 * in my_capabilities(), so there is no second identity to create and nothing to
 * switch. Waiting for a decision should not mean being unable to order lunch.
 */
export function ContinueOrdering() {
  return (
    <div className="rounded-card bg-surface border-line border p-4">
      <p className="text-sm">You can keep ordering while you wait. The same account does both.</p>
      <Link href="/order" className="text-brand-700 mt-2 inline-block text-sm font-semibold">
        Continue to ordering
      </Link>
    </div>
  );
}

async function upload(kind, blob, filename) {
  const form = new FormData();
  form.set('kind', kind);
  form.set('file', blob, filename);

  const response = await fetch('/api/verification/documents', { method: 'POST', body: form });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? 'Upload failed.');
  return body.path;
}

/**
 * The student ID card, uploaded or photographed.
 *
 * Both routes are offered because a card is the same card either way. Someone
 * with a clear photo already on their phone should use it; someone holding the
 * card should be able to point the camera at it and be done.
 */
function StudentIdUpload({ path, onUploaded }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [preview, setPreview] = usePreview();

  async function accept(file) {
    setBusy(true);
    setError(null);
    try {
      const uploaded = await upload('student-id', file, file.name || 'student-id.jpg');
      setPreview(URL.createObjectURL(file));
      onUploaded(uploaded);
    } catch (caught) {
      setError(caught.message);
      throw caught;
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-card bg-surface border-line border p-4">
      <h2 className="text-sm font-medium">
        Photo of your student ID <span className="text-bad">*</span>
      </h2>
      <p className="text-muted mt-1 text-xs leading-relaxed">
        Make sure the name and ID number are readable. It is stored privately and deleted after the
        review retention period.
      </p>

      {preview ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={preview}
            alt="The student ID you uploaded"
            className="border-line rounded-card mt-3 w-full border"
            style={{ aspectRatio: '3 / 2', objectFit: 'cover' }}
          />
          <p className="text-good mt-2 text-sm font-medium">ID received.</p>
        </>
      ) : null}

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <label className="press border-line-strong hover:bg-surface-2 inline-flex h-11 cursor-pointer items-center justify-center gap-2 rounded-full border text-sm font-semibold transition-colors">
          {path ? 'Choose another' : 'Choose a file'}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            disabled={busy}
            className="sr-only"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (!file) return;
              await accept(file).catch(() => {});
            }}
          />
        </label>

        <CameraCapture onCaptured={accept} label={path ? 'Retake photo' : 'Take a photo'} />
      </div>

      {busy ? <p className="text-muted mt-2 text-sm">Uploading…</p> : null}
      {error ? <p className="text-bad mt-2 text-sm">{error}</p> : null}
    </section>
  );
}

/**
 * An object URL that is revoked when it is replaced and when the component goes
 * away. Retaking a photo five times should not pin five images in memory.
 */
function usePreview() {
  const [url, setUrl] = useState(null);
  const current = useRef(null);

  useEffect(
    () => () => {
      if (current.current) URL.revokeObjectURL(current.current);
    },
    []
  );

  const set = (next) => {
    if (current.current) URL.revokeObjectURL(current.current);
    current.current = next;
    setUrl(next);
  };

  return [url, set];
}
