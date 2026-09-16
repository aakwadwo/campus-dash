'use client';

import Image from 'next/image';
import { useActionState, useEffect, useRef, useState } from 'react';
import {
  updateProfileAction,
  addImageAction,
  deleteImageAction,
  savePayoutDestinationAction,
} from '../actions';
import { Button, ErrorNote, Field, Input, Select, Textarea } from '@/app/ui';

function Result({ state }) {
  if (!state?.message) return null;
  if (!state.ok) return <ErrorNote>{state.message}</ErrorNote>;
  return (
    <p className="text-good text-sm font-medium" role="status">
      {state.message}
    </p>
  );
}

/**
 * Where this store's money goes.
 *
 * MOBILE MONEY ONLY, because that is what Paystack settles to in Ghana and
 * inventing a bank-account form for a rail we do not support would produce a
 * store that cannot be paid.
 *
 * THE NUMBER IS NOT ECHOED BACK. Once it is saved the form shows the last three
 * digits and asks for the whole thing again only if the vendor wants to change
 * it. There is nothing here for somebody looking over a shoulder in a busy
 * kitchen to read, and no full account number in the page source.
 */
export function PayoutForm({ vendor, destination }) {
  const [state, action, pending] = useActionState(savePayoutDestinationAction, {});

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="vendor_id" value={vendor.vendor_id} />
      <input type="hidden" name="store_name" value={vendor.name ?? ''} />

      {destination ? (
        <p className="text-muted text-sm">
          Currently paying <strong className="text-ink">{destination.momo_network}</strong> ending{' '}
          <strong className="text-ink">{destination.account_last3}</strong> in the name of{' '}
          {destination.account_name}.
        </p>
      ) : (
        <p className="text-muted text-sm leading-relaxed">
          Add the mobile money account this store is paid into. Until it is set, your share of each
          order is held by Campus Dash and settled by hand.
        </p>
      )}

      <Field label="Network">
        <Select name="momo_network" required defaultValue={destination?.momo_network ?? 'MTN'}>
          <option value="MTN">MTN Mobile Money</option>
          <option value="VODAFONE">Telecel Cash</option>
          <option value="AIRTELTIGO">AirtelTigo Money</option>
        </Select>
      </Field>

      <Field label="Mobile money number" hint="Ten digits, starting 0. For example 0551234567.">
        <Input
          name="account_number"
          required
          inputMode="numeric"
          autoComplete="off"
          placeholder={destination ? `Ends ${destination.account_last3}` : '0551234567'}
        />
      </Field>

      <Field label="Name on the account" hint="Exactly as it is registered with the network.">
        <Input name="account_name" required defaultValue={destination?.account_name ?? ''} />
      </Field>

      <Button type="submit" disabled={pending}>
        {pending ? 'Saving…' : destination ? 'Update payout details' : 'Save payout details'}
      </Button>
      <Result state={state} />
    </form>
  );
}

export function StoreDetailsForm({ vendor, categories, locations }) {
  const [state, action, pending] = useActionState(updateProfileAction, {});

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="vendor_id" value={vendor.vendor_id} />

      <Field label="Store name">
        <Input name="name" required defaultValue={vendor.name ?? ''} />
      </Field>

      <Field label="What you sell">
        <Textarea name="description" rows={3} defaultValue={vendor.description ?? ''} />
      </Field>

      <Field label="Category">
        <Select name="category_id" defaultValue={vendor.category_id ?? ''}>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Where you are" hint="The campus point students would walk to.">
        <Select name="location_id" defaultValue={vendor.location_id ?? ''}>
          <option value="">Not set</option>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Directions" hint="Anything a Partner needs to find you. Optional.">
        <Input name="location_note" defaultValue={vendor.location_note ?? ''} />
      </Field>

      <Field label="Walk to campus (minutes)" hint="Used to estimate delivery time. Optional.">
        <Input
          name="walk_minutes"
          type="number"
          min="0"
          defaultValue={vendor.walk_minutes_to_campus ?? ''}
        />
      </Field>

      <Button type="submit" disabled={pending}>
        {pending ? 'Saving…' : 'Save details'}
      </Button>
      <Result state={state} />
    </form>
  );
}

/**
 * The gallery.
 *
 * One kind of photo, not a logo plus a cover plus a gallery. A pilot store has
 * a phone and a plate of food; asking for three shapes of image is asking for
 * two of them to be missing.
 */
export function ImageForms({ vendorId, images }) {
  const [addState, add, adding] = useActionState(addImageAction, {});
  const [removeState, remove] = useActionState(deleteImageAction, {});

  return (
    <div className="space-y-5">
      {images.length ? (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {images.map((image) => (
            <li key={image.id} className="relative">
              <div className="rounded-card bg-surface-2 relative aspect-[4/3] overflow-hidden">
                <Image
                  src={image.url}
                  alt={image.caption ?? ''}
                  fill
                  sizes="(max-width: 640px) 50vw, 200px"
                  className="object-cover"
                  unoptimized
                />
              </div>
              <form action={remove} className="mt-1.5">
                <input type="hidden" name="vendor_id" value={vendorId} />
                <input type="hidden" name="image_id" value={image.id} />
                <button type="submit" className="text-bad text-xs font-medium">
                  Remove
                </button>
              </form>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted rounded-card border-line border border-dashed px-4 py-5 text-sm">
          No photos yet. Stores with a photo of the food get noticeably more orders.
        </p>
      )}
      <Result state={removeState} />

      {/* KEYED ON THE GALLERY SIZE, which is what resets the picker after a
          successful upload. A `useEffect` that cleared the fields would be
          setState inside an effect body — a cascading render — and would have
          to revoke the preview URL itself; remounting does both, and the
          unmount cleanup in usePreview is already the right place for the
          revoke. */}
      <AddPhoto
        key={images.length}
        vendorId={vendorId}
        add={add}
        adding={adding}
        state={addState}
      />
    </div>
  );
}

/**
 * Adding one photograph.
 *
 * THE FAILURE THIS FIXES was a bare file input, a caption box and an Upload
 * button: nothing happened visibly when a file was chosen, so on a phone —
 * where the picker takes a second and the preview is the only confirmation the
 * right photo was picked — the honest reading was that the tap had missed.
 * People tapped Upload twice, or chose the file again.
 *
 * So: the tile shows the local preview the instant a file is chosen, the
 * selection can be replaced or cleared before anything is sent, the pending
 * state sits on the thing being uploaded, and a failure leaves the file
 * selected so the next tap is a retry rather than starting over.
 *
 * `capture="environment"` puts the rear camera in the phone picker alongside
 * the gallery, which is what a cook standing over a plate actually wants.
 */
function AddPhoto({ vendorId, add, adding, state }) {
  const inputRef = useRef(null);
  const [chosen, setChosen] = useState(null);
  const [preview, setPreview] = usePreview();

  // A SUCCESSFUL UPLOAD CLEARS THE FORM by remounting this component — see the
  // key on it. Leaving the photo in the picker under a success message reads as
  // "it did not go", and invites a duplicate.
  const clear = () => {
    setChosen(null);
    setPreview(null);
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <form action={add} className="border-line space-y-3 border-t pt-5">
      <input type="hidden" name="vendor_id" value={vendorId} />

      <div className="flex items-start gap-4">
        <label
          className={`rounded-card border-line-strong hover:bg-surface-2 grid aspect-[4/3] w-32 shrink-0 cursor-pointer place-items-center overflow-hidden border border-dashed transition-colors ${
            adding ? 'pointer-events-none opacity-60' : ''
          }`}
        >
          {preview ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img src={preview} alt="" className="size-full object-cover" />
          ) : (
            <span className="text-muted px-2 text-center text-xs font-medium">
              Choose or take a photo
            </span>
          )}
          <input
            ref={inputRef}
            type="file"
            name="image"
            accept="image/jpeg,image/png,image/webp"
            capture="environment"
            required
            disabled={adding}
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (!file) return clear();
              setChosen(file.name);
              setPreview(URL.createObjectURL(file));
            }}
          />
        </label>

        <div className="min-w-0 flex-1 space-y-3">
          <p className="text-muted text-xs leading-relaxed">
            JPEG, PNG or WebP, under 5 MB. Up to 12 in total.
            {chosen ? (
              <span className="text-ink mt-1 block truncate font-medium">{chosen}</span>
            ) : null}
          </p>

          <Field label="Caption" hint="Optional.">
            <Input name="caption" placeholder="Jollof with grilled chicken" disabled={adding} />
          </Field>

          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" variant="secondary" disabled={adding || !chosen}>
              {adding ? 'Uploading…' : state.message && !state.ok ? 'Try again' : 'Upload photo'}
            </Button>
            {chosen && !adding ? (
              <button
                type="button"
                onClick={clear}
                className="text-muted hover:text-ink press-sm min-h-9 rounded px-2 text-sm font-medium transition-colors"
              >
                Remove
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {/* RECOVERABLE. The file stays selected on a failure, so the button above
          becomes a retry rather than sending somebody back to the picker. */}
      <Result state={state} />
    </form>
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
