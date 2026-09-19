'use client';

import StorePhotos from '@/app/store-photos';
import {
  addVendorImageAction,
  deleteVendorImageAction,
  setVendorPrimaryImageAction,
} from '../../actions';

/**
 * Store photos, from the admin side.
 *
 * The same component and the same database functions the store's own screen
 * uses. The authorisation question (owner or admin) is asked once, in SQL,
 * rather than twice in two languages.
 */
export default function VendorImageForms({ vendorId, images }) {
  return (
    <StorePhotos
      vendorId={vendorId}
      images={images}
      addAction={addVendorImageAction}
      removeAction={deleteVendorImageAction}
      primaryAction={setVendorPrimaryImageAction}
    />
  );
}
