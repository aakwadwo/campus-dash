'use client';

import { useActionState } from 'react';
import { setVendorStatusAction } from '../../actions';
import { Select, ReasonField, Button, ActionResult } from '../../ui';

export default function VendorStatusForm({ vendor }) {
  const [state, action, pending] = useActionState(setVendorStatusAction, {});

  return (
    <form action={action} className="grid gap-4 sm:grid-cols-2">
      <input type="hidden" name="vendor_id" value={vendor.id} />
      <Select
        label="Status"
        name="status"
        required
        defaultValue={vendor.status}
        options={[
          { value: 'DRAFT', label: 'DRAFT — being set up' },
          { value: 'ACTIVE', label: 'ACTIVE — can trade' },
          { value: 'SUSPENDED', label: 'SUSPENDED — cannot trade' },
        ]}
        hint="Moving away from ACTIVE also closes them to new orders."
      />
      <ReasonField placeholder="Hygiene complaint under review" />
      <div className="sm:col-span-2">
        <Button disabled={pending}>{pending ? 'Saving…' : 'Update status'}</Button>
        <ActionResult state={state} />
      </div>
    </form>
  );
}
