'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Taking a photograph with the device camera, in the page.
 *
 * TWO WAYS IN, and neither is required. Some people have the thing already on
 * their phone — a screenshot of a scan, a PDF from the university — and telling
 * them to photograph their own screen would be absurd. Others are holding the
 * paper. So this component is one half of a pair: the caller renders a file
 * input beside it, and this is the "or take one now" half.
 *
 * getUserMedia FIRST, with a fallback. On a laptop the camera stream is the
 * only way to take a picture at all. On a phone `capture="environment"` opens
 * the native camera app, which is faster and better than a stream in a page —
 * but it is a file input, so a browser that blocks camera access still leaves
 * somebody a way through. Both end at the same upload.
 *
 * The stream is stopped on every exit path, including unmount. A camera light
 * that stays on after the photograph is taken is alarming, and rightly so.
 */
export default function CameraCapture({
  onCaptured,
  facingMode = 'environment',
  label = 'Take a photo',
  className = '',
}) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const fallbackRef = useRef(null);
  const [streaming, setStreaming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => () => stopStream(streamRef), []);

  async function open() {
    setError(null);

    // No camera API at all — an old browser, or an insecure origin. Hand
    // straight over to the native picker rather than showing a dead button.
    if (!navigator.mediaDevices?.getUserMedia) {
      fallbackRef.current?.click();
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setStreaming(true);
    } catch {
      // Refused, or in use by something else. The native camera app is a
      // separate permission and often works when the in-page stream does not.
      fallbackRef.current?.click();
    }
  }

  function close() {
    stopStream(streamRef);
    setStreaming(false);
  }

  async function take() {
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

      close();
      await onCaptured(new File([blob], 'photo.jpg', { type: 'image/jpeg' }));
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={className}>
      {streaming ? (
        <>
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
              {busy ? 'Saving…' : 'Capture'}
            </button>
            <button
              type="button"
              onClick={close}
              className="press border-line-strong h-11 rounded-full border px-5 text-sm font-semibold"
            >
              Cancel
            </button>
          </div>
        </>
      ) : (
        <button
          type="button"
          onClick={open}
          className="press border-line-strong hover:bg-surface-2 inline-flex h-11 w-full items-center justify-center gap-2 rounded-full border text-sm font-semibold transition-colors"
        >
          <CameraGlyph />
          {label}
        </button>
      )}

      {/* The fallback, and the reason it is hidden rather than absent: on a
          phone this is the better path, and open() clicks it deliberately. */}
      <input
        ref={fallbackRef}
        type="file"
        accept="image/*"
        capture={facingMode === 'user' ? 'user' : 'environment'}
        className="hidden"
        onChange={async (event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
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
        }}
      />

      {error ? <p className="text-bad mt-2 text-sm">{error}</p> : null}
    </div>
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
    >
      <path d="M4 8h3l1.5-2h7L17 8h3v11H4V8Z" strokeLinejoin="round" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
  );
}
