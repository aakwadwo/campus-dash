'use client';

import { useActionState, useEffect, useRef, useState, startTransition } from 'react';
import { resizeImage } from './image-resize';
import { ErrorNote, Spinner } from './ui';

/** Four, and the first is the one a customer sees on the store's card. */
export const MAX_STORE_PHOTOS = 4;

/**
 * A store's photos: its counter, its food, whatever it sells.
 *
 * ONE COMPONENT FOR THE STORE AND FOR AN ADMINISTRATOR, handed the actions it
 * should call, so the two screens behave identically and cannot drift.
 *
 * THE FIRST PHOTO LEADS. It is the one on the store's card in the marketplace
 * and on the landing page; the rest appear when a customer opens the store. A
 * new photo goes to the end, so the first ever uploaded stays primary until
 * somebody chooses another.
 *
 * TWO WAYS TO ADD ONE, and they are separate inputs on purpose. "Choose photo"
 * has no `capture` attribute, so a phone offers its library (and usually the
 * camera too). "Take photo" carries `capture="environment"`, which opens the
 * camera directly; it is shown only on touch devices, where that attribute
 * means something. Putting `capture` on the only input is what takes the photo
 * library away.
 *
 * A photo uploads the moment it is chosen, shrunk in the browser first (see
 * image-resize.js), so there is no second "Upload" tap to forget.
 */
export default function StorePhotos({ vendorId, images, addAction, removeAction, primaryAction }) {
  const [addState, add, adding] = useActionState(addAction, {});
  const [removeState, remove, removing] = useActionState(removeAction, {});
  const [primaryState, makePrimary, reordering] = useActionState(primaryAction, {});
  const [preparing, setPreparing] = useState(false);
  const [preview, setPreview] = usePreview();

  const full = images.length >= MAX_STORE_PHOTOS;
  const busy = preparing || adding;

  // The local preview shows only while its upload is in flight. A finished
  // upload is in `images`; a failed one is explained below instead.
  const pending = busy ? preview : null;

  async function upload(file) {
    if (!file) return;
    setPreparing(true);
    setPreview(URL.createObjectURL(file));
    const ready = await resizeImage(file);
    const form = new FormData();
    form.set('vendor_id', vendorId);
    form.set('image', ready, ready.name);
    setPreparing(false);
    startTransition(() => add(form));
  }

  const failure = [addState, removeState, primaryState].find((s) => s?.message && !s.ok);

  return (
    <div>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {images.map((image, index) => (
          <li key={image.id} className="min-w-0">
            <div className="rounded-card bg-surface-2 relative aspect-[4/3] overflow-hidden">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={image.url} alt="" className="size-full object-cover" />
              {index === 0 ? (
                <span className="bg-surface text-ink absolute top-2 left-2 rounded-full px-2 py-0.5 text-[11px] font-semibold">
                  Main photo
                </span>
              ) : null}
            </div>
            <div className="mt-1 flex flex-wrap gap-x-3 text-xs font-medium">
              {index > 0 ? (
                <form action={makePrimary}>
                  <input type="hidden" name="vendor_id" value={vendorId} />
                  <input type="hidden" name="image_id" value={image.id} />
                  <button
                    type="submit"
                    disabled={reordering || removing}
                    className="text-muted hover:text-ink min-h-9 disabled:opacity-55"
                  >
                    Make main
                  </button>
                </form>
              ) : null}
              <form action={remove}>
                <input type="hidden" name="vendor_id" value={vendorId} />
                <input type="hidden" name="image_id" value={image.id} />
                <button
                  type="submit"
                  disabled={removing || reordering}
                  className="text-bad min-h-9 disabled:opacity-55"
                >
                  Remove
                </button>
              </form>
            </div>
          </li>
        ))}

        {pending ? (
          <li>
            <div className="rounded-card bg-surface-2 relative aspect-[4/3] overflow-hidden">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={pending} alt="" className="size-full object-cover opacity-60" />
              <span className="absolute inset-0 grid place-items-center">
                <Spinner className="text-ink size-5" />
              </span>
            </div>
          </li>
        ) : null}
      </ul>

      {full ? (
        <p className="text-muted mt-3 text-sm">
          {MAX_STORE_PHOTOS} of {MAX_STORE_PHOTOS}. Remove one to add another.
        </p>
      ) : (
        <div className={`flex flex-wrap gap-2 ${images.length || pending ? 'mt-4' : ''}`}>
          <PhotoPicker label="Choose photo" disabled={busy} onFile={upload} />
          <PhotoPicker label="Take photo" capture disabled={busy} onFile={upload} />
          {images.length === 0 && !pending ? (
            <p className="text-muted basis-full text-sm">
              Up to {MAX_STORE_PHOTOS}. The first one is shown on your store’s card.
            </p>
          ) : null}
        </div>
      )}

      {failure ? <ErrorNote className="mt-3">{failure.message}</ErrorNote> : null}
    </div>
  );
}

/**
 * One way in. A label wrapping a hidden input, so it is a real button to a
 * screen reader and a keyboard, and the whole pill is the target.
 */
function PhotoPicker({ label, capture = false, disabled, onFile }) {
  const input = useRef(null);
  return (
    <label
      className={`press border-line-strong hover:bg-surface-2 inline-flex h-10 cursor-pointer items-center justify-center rounded-full border px-4 text-sm font-semibold transition-colors ${
        capture ? 'hidden pointer-coarse:inline-flex' : ''
      } ${disabled ? 'pointer-events-none opacity-55' : ''}`}
    >
      {label}
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        {...(capture ? { capture: 'environment' } : {})}
        disabled={disabled}
        className="sr-only"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          onFile(file);
        }}
      />
    </label>
  );
}

/** An object URL that is revoked when replaced and on unmount. */
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
