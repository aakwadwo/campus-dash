'use client';

import { useActionState } from 'react';
import { addVendorImageAction, deleteVendorImageAction } from '../../actions';
import { Field, Button, ActionResult, Empty } from '../../ui';

/**
 * Storefront photographs, from the admin side.
 *
 * The same two database functions the vendor's own screen uses. The
 * authorisation question — owner or admin — is asked once, in SQL, rather than
 * twice in two languages.
 */
export default function VendorImageForms({ vendorId, images }) {
  const [addState, add, adding] = useActionState(addVendorImageAction, {});
  const [removeState, remove] = useActionState(deleteVendorImageAction, {});

  return (
    <div className="space-y-5">
      {images.length ? (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {images.map((image) => (
            <li key={image.id}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={image.url}
                alt={image.caption ?? ''}
                className="aspect-[4/3] w-full rounded object-cover"
              />
              <form action={remove} className="mt-1.5">
                <input type="hidden" name="vendor_id" value={vendorId} />
                <input type="hidden" name="image_id" value={image.id} />
                <button type="submit" className="text-bad text-xs font-medium">
                  Delete
                </button>
              </form>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>No photos yet.</Empty>
      )}
      <ActionResult state={removeState} />

      <form action={add} className="grid gap-4 sm:grid-cols-2">
        <input type="hidden" name="vendor_id" value={vendorId} />
        <div className="sm:col-span-2">
          <label className="mb-1.5 block text-sm font-medium">Add a photo</label>
          <input
            type="file"
            name="image"
            accept="image/jpeg,image/png,image/webp"
            required
            className="text-muted file:bg-surface-2 file:text-ink w-full text-sm file:mr-3 file:rounded-full file:border-0 file:px-4 file:py-2 file:text-sm file:font-medium"
          />
        </div>
        <Field label="Caption" name="caption" placeholder="Jollof with grilled chicken" />
        <div className="sm:col-span-2">
          <Button disabled={adding}>{adding ? 'Uploading…' : 'Upload photo'}</Button>
          <ActionResult state={addState} />
        </div>
      </form>
    </div>
  );
}
