'use client';

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
        className="bg-brand-600 w-full rounded-lg py-4 text-base font-semibold text-white disabled:opacity-60"
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
            onUploaded(await upload('student-id', file, file.name));
          } catch (caught) {
            setError(caught.message);
          } finally {
            setBusy(false);
          }
        }}
        className="mt-3 w-full text-sm"
      />

      {busy ? <p className="text-muted mt-2 text-sm">Uploading…</p> : null}
      {path ? (
        <p className="text-brand-700 mt-2 text-sm font-medium">✓ Student ID received</p>
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

      onUploaded(await upload('face', blob, 'face.jpg'));
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
              className="bg-brand-600 mt-3 w-full rounded-lg py-3 text-sm font-semibold text-white disabled:opacity-60"
            >
              {busy ? 'Saving…' : 'Take photo'}
            </button>
          )}
        </>
      ) : (
        <p className="text-brand-700 mt-3 text-sm font-medium">✓ Photo taken</p>
      )}

      {error ? <p className="mt-2 text-sm text-red-700">{error}</p> : null}
    </section>
  );
}

function stopStream(ref) {
  ref.current?.getTracks().forEach((track) => track.stop());
  ref.current = null;
}
