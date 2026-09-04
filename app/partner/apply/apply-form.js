'use client';

import Link from 'next/link';
import { useActionState, useEffect, useRef, useState } from 'react';
import { applyAction } from '../actions';

/**
 * Becoming a Partner.
 *
 * This form asks for ONE thing, and that is the whole design. Name, student ID
 * number, class year, email and the ID photograph are already on the account —
 * they were collected at student onboarding, and the database refuses this
 * application without them. Re-asking would imply a second identity is being
 * created, which is exactly the confusion this flow exists to avoid.
 *
 * The FACE photograph is captured from the live camera stream in this
 * component, and there is no file input for it anywhere in the markup. The
 * point of the selfie is that an admin can compare a real face against the ID,
 * so a saved image would defeat it.
 *
 * This is a deterrent, not a guarantee: anyone can POST to the upload endpoint
 * directly. The actual control is that a human reviews every application.
 */
export default function ApplyForm({ profile }) {
  const [state, submit, submitting] = useActionState(applyAction, {});
  const [facePath, setFacePath] = useState('');

  // The form is REPLACED on success. Leaving a filled-in form on screen under a
  // success message reads as "nothing happened" and invites a second submission
  // — which partner_apply() would accept, resetting the review clock.
  if (state.submitted) {
    return (
      <section className="mt-6 space-y-4">
        <div className="rounded-lg bg-white p-4 ring-1 ring-black/5">
          <h2 className="text-base font-semibold">Application submitted</h2>
          <p className="text-muted mt-2 text-sm leading-relaxed">
            We&rsquo;ll review your application and notify you when a decision is made. Reviewing is
            done by hand, so it is not instant.
          </p>
        </div>
        <ContinueOrdering />
      </section>
    );
  }

  return (
    <form action={submit} className="mt-6 space-y-6">
      <input type="hidden" name="face_image_path" value={facePath} />

      {/* Read-only, and shown rather than re-asked: this is the evidence the
          reviewer will compare the selfie against, and seeing it here is how an
          applicant understands that the same account is being upgraded. */}
      <section className="rounded-lg bg-white p-4 ring-1 ring-black/5">
        <h2 className="text-sm font-medium">Your student details</h2>
        <p className="text-muted mt-1 text-xs">
          Already on your account. A reviewer compares your selfie against this ID.
        </p>
        <dl className="mt-3 space-y-1.5 text-sm">
          <Row label="Student ID" value={profile?.student_id_number} />
          <Row label="Class year" value={profile?.class_year} />
          <Row label="ID photo" value={profile?.has_student_id ? 'On file' : 'Missing'} />
        </dl>
        <Link
          href="/onboarding"
          className="text-brand-700 mt-3 inline-block text-xs font-medium underline underline-offset-4"
        >
          Something wrong? Update your student details
        </Link>
      </section>

      <FaceCapture path={facePath} onUploaded={setFacePath} />

      {state.message ? (
        <p
          role={state.ok ? 'status' : 'alert'}
          className={`text-sm ${state.ok ? 'text-brand-700' : 'text-red-700'}`}
        >
          {state.message}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={submitting || !facePath}
        className="bg-brand-500 text-ink w-full rounded-lg py-4 text-base font-semibold disabled:opacity-60"
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
      <dd className="font-medium">{value ?? '—'}</dd>
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
    <div className="rounded-lg bg-white p-4 ring-1 ring-black/5">
      <p className="text-sm">You can keep ordering while you wait — the same account does both.</p>
      <Link href="/order" className="text-brand-700 mt-2 inline-block text-sm font-medium">
        Continue to ordering →
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

/** Live camera only. There is no file input in this component, by design. */
function FaceCapture({ path, onUploaded }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const [streaming, setStreaming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [preview, setPreview] = usePreview();

  // Always release the camera when this component goes away.
  useEffect(() => {
    return () => stopStream(streamRef);
  }, []);

  async function start() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user' },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setStreaming(true);
    } catch {
      setError(
        'Campus Dash could not open your camera. Allow camera access and try again — a saved photo cannot be used for this step.'
      );
    }
  }

  async function capture() {
    const video = videoRef.current;
    if (!video) return;

    setBusy(true);
    setError(null);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);

      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
      if (!blob) throw new Error('Could not read the camera image.');

      const uploaded = await upload('face', blob, 'face.jpg');
      setPreview(URL.createObjectURL(blob));
      onUploaded(uploaded);
      stopStream(streamRef);
      setStreaming(false);
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-lg bg-white p-4 ring-1 ring-black/5">
      <h2 className="text-sm font-medium">
        Live photo of your face <span className="text-red-700">*</span>
      </h2>
      <p className="text-muted mt-1 text-xs">
        Taken now, with your camera. You cannot upload a saved picture for this step. It is the only
        thing this application asks for that your account does not already have.
      </p>
      {/* Said before the camera opens, not after the photo is taken. Someone
          who would rather not be shown to customers should learn that while it
          is still a choice. */}
      <p className="mt-2 rounded bg-black/[0.03] p-2 text-xs leading-relaxed">
        This photo will be used as your Partner profile photo and may be shown to customers when you
        accept their deliveries.
      </p>

      {!path ? (
        <>
          <video
            ref={videoRef}
            playsInline
            muted
            className={`mt-3 w-full rounded bg-black/5 ${streaming ? '' : 'hidden'}`}
            style={{ aspectRatio: '3 / 4', objectFit: 'cover' }}
          />
          {!streaming ? (
            <button
              type="button"
              onClick={start}
              className="mt-3 w-full rounded-lg py-3 text-sm font-semibold ring-1 ring-black/15"
            >
              Open camera
            </button>
          ) : (
            <button
              type="button"
              onClick={capture}
              disabled={busy}
              className="bg-brand-500 text-ink mt-3 w-full rounded-lg py-3 text-sm font-semibold disabled:opacity-60"
            >
              {busy ? 'Saving…' : 'Take photo'}
            </button>
          )}
        </>
      ) : (
        <>
          {preview ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={preview}
              alt="The live photograph you just took"
              className="mt-3 w-full rounded ring-1 ring-black/10"
              style={{ aspectRatio: '3 / 4', objectFit: 'cover' }}
            />
          ) : null}
          <p className="text-brand-700 mt-2 text-sm font-medium">✓ Photo taken</p>
          <button
            type="button"
            onClick={() => {
              setPreview(null);
              onUploaded('');
              start();
            }}
            className="mt-2 w-full rounded-lg py-3 text-sm font-semibold ring-1 ring-black/15"
          >
            Retake photo
          </button>
        </>
      )}

      {error ? <p className="mt-2 text-sm text-red-700">{error}</p> : null}
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

  useEffect(() => () => {
    if (current.current) URL.revokeObjectURL(current.current);
  }, []);

  const set = (next) => {
    if (current.current) URL.revokeObjectURL(current.current);
    current.current = next;
    setUrl(next);
  };

  return [url, set];
}

function stopStream(ref) {
  ref.current?.getTracks().forEach((track) => track.stop());
  ref.current = null;
}
