'use client';

import { useActionState } from 'react';
import { updateVendorAction } from '../../actions';
import { Field, Select, ReasonField, Button, ActionResult } from '../../ui';

export default function VendorSettingsForm({ vendor, locations }) {
  const [state, action, pending] = useActionState(updateVendorAction, {});

  return (
    <form action={action} className="grid gap-4 sm:grid-cols-2">
      <input type="hidden" name="vendor_id" value={vendor.id} />
      <Field label="Name" name="name" defaultValue={vendor.name} />
      <Field label="Phone" name="phone" type="tel" defaultValue={vendor.phone} />
      <Select
        label="Location"
        name="location_id"
        defaultValue={vendor.location_id ?? ''}
        options={[
          { value: '', label: '(unchanged)' },
          ...locations.map((l) => ({ value: l.id, label: `${l.name} (${l.kind})` })),
        ]}
      />
      <Field
        label="Walk to campus (minutes)"
        name="walk_minutes"
        type="number"
        min="0"
        defaultValue={vendor.walk_minutes_to_campus ?? ''}
      />
      <div className="sm:col-span-2">
        <Field
          label="Location note"
          name="location_note"
          defaultValue={vendor.location_note ?? ''}
        />
      </div>
      <div className="sm:col-span-2">
        <ReasonField placeholder="Corrected phone number after visit" />
      </div>
      <div className="sm:col-span-2">
        <Button disabled={pending}>{pending ? 'Saving…' : 'Save details'}</Button>
        <ActionResult state={state} />
      </div>
    </form>
  );
}
