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
 * already established who this is. Re-asking for a name would imply a second
 * identity is being created, which is exactly the confusion this flow exists to
 * avoid.
 *
 * Nor is a student ID NUMBER asked for, here or anywhere any more. What a
 * reviewer judges is the card; a number typed into a box was never checked
 * against anything.
 *
 * There is also no face photograph any more. It proved nothing the school
 * address had not already proved, and it was the most sensitive thing Campus
 * Dash was storing. What remains is the student ID card, the Partner terms, and
 * a person at Campus Dash reading the application.
 */
export default function ApplyForm() {
  const [state, submit, submitting] = useActionState(applyAction, {});
  const [idPath, setIdPath] = useState('');
  const [accepted, setAccepted] = useState(false);

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

      <StudentIdUpload path={idPath} onUploaded={setIdPath} />

      {/* THE AGREEMENT IS RECORDED, not implied by a sentence under a button.
          partner_apply() writes the acceptance against the published version in
          the same transaction as the application. */}
      <label className="border-line bg-surface-2 rounded-card flex items-start gap-3 border p-3.5">
        <input
          type="checkbox"
          name="accept_terms"
          checked={accepted}
          onChange={(event) => setAccepted(event.target.checked)}
          className="accent-brand-500 mt-0.5 size-4 shrink-0"
        />
        <span className="text-muted text-sm leading-relaxed">
          I accept the{' '}
          <Link
            href="/terms?audience=PARTNER"
            className="text-brand-700 font-medium underline underline-offset-4"
          >
            Campus Dash Partner terms
          </Link>
          .
        </span>
      </label>

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
        disabled={submitting || !idPath || !accepted}
        className="press bg-brand-700 hover:bg-brand-800 w-full rounded-full py-4 text-base font-semibold text-white transition-colors disabled:opacity-55"
      >
        {submitting ? (
          <span className="inline-flex items-center gap-2">
            <span
              aria-hidden
              className="inline-block size-4 animate-spin rounded-full border-2 border-white/35 border-t-white"
            />
            Submitting…
          </span>
        ) : (
          'Submit application'
        )}
      </button>
      {!idPath ? (
        <p className="text-muted text-center text-xs">
          Add a photo of your student ID to continue.
        </p>
      ) : null}
    </form>
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
        Make sure your name and photo are readable. It is stored privately and deleted after the
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
