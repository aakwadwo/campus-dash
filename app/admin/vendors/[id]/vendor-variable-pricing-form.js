'use client';

import { useActionState } from 'react';
import { setVendorVariablePricingAction } from '../../actions';
import { Select, ReasonField, Button, ActionResult } from '../../ui';

/**
 * Customer-chosen prices for one store.
 *
 * Its own control with a reason, like meal scans: it is a capability Campus
 * Dash grants, not a detail of the store. With it the store decides which of
 * its items use it; without it those items are hidden and kept.
 */
export default function VendorVariablePricingForm({ vendor }) {
  const [state, action, pending] = useActionState(setVendorVariablePricingAction, {});

  return (
    <form action={action} className="grid gap-4 sm:grid-cols-2">
      <input type="hidden" name="vendor_id" value={vendor.id} />
      <Select
        label="Customer-chosen prices"
        name="enabled"
        required
        defaultValue={vendor.can_use_variable_pricing ? 'true' : 'false'}
        options={[
          { value: 'false', label: 'Off' },
          { value: 'true', label: 'On' },
        ]}
      />
      <ReasonField placeholder="Agreed with the store owner" />
      <div className="sm:col-span-2">
        <Button disabled={pending}>{pending ? 'Saving…' : 'Update pricing'}</Button>
        <ActionResult state={state} />
      </div>
    </form>
  );
}
