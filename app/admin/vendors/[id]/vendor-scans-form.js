'use client';

import { useActionState } from 'react';
import { setVendorScansAction } from '../../actions';
import { Select, ReasonField, Button, ActionResult } from '../../ui';

/**
 * Scan capability for one restaurant.
 *
 * Deliberately its own control rather than a checkbox on the details form: it
 * is the only vendor setting that sends a Partner somewhere expecting to be
 * served without paying, so it should be turned on as a decision, with a reason
 * recorded, and not as a side effect of editing a phone number.
 */
export default function VendorScansForm({ vendor }) {
  const [state, action, pending] = useActionState(setVendorScansAction, {});

  return (
    <form action={action} className="grid gap-4 sm:grid-cols-2">
      <input type="hidden" name="vendor_id" value={vendor.id} />
      <Select
        label="Campus meal scans"
        name="accepts"
        required
        defaultValue={vendor.can_accept_scans ? 'true' : 'false'}
        options={[
          { value: 'false', label: 'Does not accept scans' },
          { value: 'true', label: 'Accepts scans' },
        ]}
        hint="Only turn this on for a restaurant that really is on the university meal system."
      />
      <ReasonField placeholder="Confirmed with the restaurant manager" />
      <div className="sm:col-span-2">
        <Button disabled={pending}>{pending ? 'Saving…' : 'Update scan capability'}</Button>
        <ActionResult state={state} />
      </div>
    </form>
  );
}
