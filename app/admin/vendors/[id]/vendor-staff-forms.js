'use client';

import { useActionState } from 'react';
import { addVendorUserAction, removeVendorUserAction } from '../../actions';
import { Field, ReasonField, Button, ActionResult, Empty } from '../../ui';

export default function VendorStaffForms({ vendorId, staff }) {
  const [addState, addAction, adding] = useActionState(addVendorUserAction, {});
  const [removeState, removeAction, removing] = useActionState(removeVendorUserAction, {});

  return (
    <>
      {staff.length ? (
        <ul className="divide-line mb-6 divide-y text-sm">
          {staff.map((person) => (
            <li key={person.id} className="flex flex-wrap items-center gap-3 py-2">
              <span className="font-medium">{person.full_name ?? 'Unnamed'}</span>
              <span className="text-muted tabular-nums">{person.phone}</span>
              <form action={removeAction} className="ml-auto flex items-center gap-2">
                <input type="hidden" name="vendor_id" value={vendorId} />
                <input type="hidden" name="user_id" value={person.id} />
                <input
                  name="reason"
                  required
                  minLength={3}
                  placeholder="Reason"
                  className="border-line-strong w-44 rounded border px-2 py-1 text-xs"
                />
                <Button variant="danger" disabled={removing}>
                  Remove
                </Button>
              </form>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>Nobody can act for this vendor yet.</Empty>
      )}
      <ActionResult state={removeState} />

      <form action={addAction} className="mt-4 grid gap-4 sm:grid-cols-2">
        <input type="hidden" name="vendor_id" value={vendorId} />
        <Field
          label="Add staff by phone"
          name="phone"
          type="tel"
          required
          placeholder="+233201234567"
          hint="The person must already have signed in to Campus Dash at least once."
        />
        <ReasonField placeholder="New counter staff" />
        <div className="sm:col-span-2">
          <Button disabled={adding}>{adding ? 'Adding…' : 'Add staff'}</Button>
          <ActionResult state={addState} />
        </div>
      </form>
    </>
  );
}
