'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

/**
 * "Take photo": the device camera, and nothing else.
 *
 * THE OTHER HALF IS THE CALLER'S. Every screen that uses this also renders a
 * plain file input for choosing an existing photo or file. That input carries
 * NO `capture` attribute, so it opens the library; this one opens the camera.
 * Two buttons, two jobs, and neither pretends to be the other.
 *
 * TWO ROUTES TO A CAMERA, chosen by the device rather than tried in turn:
 *
 *   * A TOUCH DEVICE gets a file input with `capture`, which opens the phone's
 *     own camera app. It is faster and better than a stream in a page, and it
 *     is the route that works when a browser is stingy with getUserMedia.
 *   * A LAPTOP gets the camera in the page, through getUserMedia. `capture`
 *     means nothing there, so a capture input would only have opened a second
 *     file picker, which is exactly the confusion this replaces.
 *
 * WHY IT WAS BROKEN. The <video> only rendered once streaming had started, so
 * the stream was attached to an element that did not exist yet: the preview
 * stayed black and the capture came back empty. The video is now always in the
 * page, hidden until there is something to show.
 *
 * The stream is stopped on every exit path, including unmount. A camera light
 * that stays on after the photograph is taken is alarming, and rightly so.
 */
export default function CameraCapture({
  onCaptured,
  facingMode = 'environment',
  label = 'Take photo',
  disabled = false,
  className = '',
}) {
  const touch = useCoarsePointer();
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const [streaming, setStreaming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => () => stopStream(streamRef), []);

  async function hand(file) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      await onCaptured(file);
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy(false);
    }
  }

  async function open() {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('This browser cannot open the camera. Choose a photo instead.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current;
      video.srcObject = stream;
      await video.play();
      setStreaming(true);
    } catch (caught) {
      stopStream(streamRef);
      setError(
        caught?.name === 'NotAllowedError'
          ? 'Camera access was blocked. Allow it in your browser, or choose a photo instead.'
          : 'No camera was found. Choose a photo instead.'
      );
    }
  }

  function close() {
    stopStream(streamRef);
    if (videoRef.current) videoRef.current.srcObject = null;
    setStreaming(false);
  }

  async function take() {
    const video = videoRef.current;
    if (!video?.videoWidth) return;

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    close();
    if (!blob) {
      setError('Could not read the camera image. Try again.');
      return;
    }
    await hand(new File([blob], 'photo.jpg', { type: 'image/jpeg' }));
  }

  const pill =
    'press border-line-strong hover:bg-surface-2 inline-flex h-11 w-full items-center justify-center gap-2 rounded-full border text-sm font-semibold transition-colors';

  return (
    <div className={className}>
      {touch ? (
        <label
          className={`${pill} cursor-pointer ${busy || disabled ? 'pointer-events-none opacity-55' : ''}`}
        >
          <CameraGlyph />
          {label}
          <input
            type="file"
            accept="image/*"
            capture={facingMode === 'user' ? 'user' : 'environment'}
            disabled={busy || disabled}
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              hand(file);
            }}
          />
        </label>
      ) : streaming ? null : (
        <button type="button" onClick={open} disabled={busy || disabled} className={pill}>
          <CameraGlyph />
          {label}
        </button>
      )}

      {/* ALWAYS MOUNTED on a laptop, so open() has somewhere to attach the
          stream. Hidden until it is actually showing something. */}
      {touch ? null : (
        <div className={streaming ? 'mt-1' : 'hidden'}>
          <video
            ref={videoRef}
            playsInline
            muted
            className="bg-surface-2 rounded-card w-full"
            style={{ aspectRatio: '4 / 3', objectFit: 'cover' }}
          />
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={take}
              disabled={busy}
              className="press bg-brand-700 h-11 flex-1 rounded-full text-sm font-semibold text-white transition-colors disabled:opacity-55"
            >
              Capture
            </button>
            <button
              type="button"
              onClick={close}
              className="press border-line-strong h-11 rounded-full border px-5 text-sm font-semibold"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error ? <p className="text-bad mt-2 text-sm">{error}</p> : null}
    </div>
  );
}

/**
 * Whether the primary pointer is a finger. False during server rendering, so a
 * phone briefly renders the laptop button before hydration swaps it: harmless,
 * because nothing happens until it is pressed.
 */
function useCoarsePointer() {
  return useSyncExternalStore(
    (notify) => {
      const query = window.matchMedia('(pointer: coarse)');
      query.addEventListener('change', notify);
      return () => query.removeEventListener('change', notify);
    },
    () => window.matchMedia('(pointer: coarse)').matches,
    () => false
  );
}

function stopStream(ref) {
  ref.current?.getTracks().forEach((track) => track.stop());
  ref.current = null;
}

function CameraGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      className="size-4"
      aria-hidden
    >
      <path d="M4 8h3l1.5-2h7L17 8h3v11H4V8Z" strokeLinejoin="round" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
  );
}
