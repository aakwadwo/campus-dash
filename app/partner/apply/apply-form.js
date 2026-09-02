'use client';

import Link from 'next/link';
import { useActionState, useEffect, useRef, useState } from 'react';
import { applyAction } from '../actions';

/**
 * Partner application.
 *
 * The student ID may be a photo from the gallery — it is a document, and people
 * usually already have a picture of it.
 *
 * The FACE photograph may not. It is captured from the live camera stream in
 * this component, and there is no file input for it anywhere in the markup.
 * The point of the selfie is that an admin can compare a real face against the
 * ID, so a saved image would defeat it.
 *
 * This is a deterrent, not a guarantee: anyone can POST to the upload endpoint
 * directly. The actual control is that a human reviews every application.
 */
export default function ApplyForm() {
  const [state, submit, submitting] = useActionState(applyAction, {});
  const [studentIdPath, setStudentIdPath] = useState('');
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
        <div className="rounded-lg bg-white p-4 ring-1 ring-black/5">
          <p className="text-sm">
            You can keep ordering while you wait — the same account does both.
          </p>
          <Link href="/order" className="text-brand-700 mt-2 inline-block text-sm font-medium">
            Continue to ordering →
          </Link>
        </div>
      </section>
    );
  }

  return (
    <form action={submit} className="mt-6 space-y-6">
      <input type="hidden" name="student_id_image_path" value={studentIdPath} />
      <input type="hidden" name="face_image_path" value={facePath} />

      <label className="block">
        <span className="text-sm font-medium">
          Student ID number <span className="text-red-700">*</span>
        </span>
        <input
          name="student_id_number"
          required
          placeholder="e.g. 10012345"
          className="mt-1 w-full rounded border border-black/15 px-3 py-2.5 text-base"
        />
      </label>

      <label className="block">
        <span className="text-sm font-medium">
          Class year <span className="text-red-700">*</span>
        </span>
        <input
          name="class_year"
          required
          placeholder="e.g. Class of 2029"
          className="mt-1 w-full rounded border border-black/15 px-3 py-2.5 text-base"
        />
      </label>

      <label className="block">
        <span className="text-sm font-medium">
          Email address <span className="text-red-700">*</span>
        </span>
        <input
          name="email"
          type="email"
          required
          autoComplete="email"
          placeholder="you@example.com"
          className="mt-1 w-full rounded border border-black/15 px-3 py-2.5 text-base"
        />
        <span className="text-muted mt-1 block text-xs">
          Any working address. A school address is not required.
        </span>
      </label>

      <StudentIdCapture path={studentIdPath} onUploaded={setStudentIdPath} />
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
        disabled={submitting || !studentIdPath || !facePath}
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

async function upload(kind, blob, filename) {
  const form = new FormData();
  form.set('kind', kind);
  form.set('file', blob, filename);

  const response = await fetch('/api/partner/documents', { method: 'POST', body: form });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? 'Upload failed.');
  return body.path;
}

/** A document, so a gallery photo is fine. */
function StudentIdCapture({ path, onUploaded }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // Object URLs are revoked when replaced and on unmount; a preview that leaks
  // one per retry holds the whole image in memory for the life of the page.
  const [preview, setPreview] = usePreview();

  return (
    <section className="rounded-lg bg-white p-4 ring-1 ring-black/5">
      <h2 className="text-sm font-medium">
        Photo of your student ID <span className="text-red-700">*</span>
      </h2>
      <p className="text-muted mt-1 text-xs">
        Make sure the name, photo and ID number are readable.
      </p>

      <input
        type="file"
        accept="image/jpeg,image/png,image/webp"
        capture="environment"
        disabled={busy}
        onChange={async (event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          setBusy(true);
          setError(null);
          try {
            const uploaded = await upload('student-id', file, file.name);
            setPreview(URL.createObjectURL(file));
            onUploaded(uploaded);
          } catch (caught) {
            setError(caught.message);
          } finally {
            setBusy(false);
          }
        }}
        className="mt-3 w-full text-sm"
      />

      {busy ? <p className="text-muted mt-2 text-sm">Uploading…</p> : null}

      {/* Check it before submitting: an unreadable ID is the single most common
          reason an application comes back rejected. */}
      {preview ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={preview}
          alt="The student ID photograph you selected"
          className="mt-3 w-full rounded ring-1 ring-black/10"
        />
      ) : null}
      {path ? (
        <p className="text-brand-700 mt-2 text-sm font-medium">
          ✓ Student ID received — check the name, photo and number are readable, and choose another
          file above if not.
        </p>
      ) : null}
      {error ? <p className="mt-2 text-sm text-red-700">{error}</p> : null}
    </section>
  );
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
        Taken now, with your camera. You cannot upload a saved picture for this step.
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
