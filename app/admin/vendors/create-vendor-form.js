'use client';

import { useActionState } from 'react';
import { createVendorAction } from '../actions';
import { Field, Select, ReasonField, Button, ActionResult } from '../ui';

export default function CreateVendorForm({ locations }) {
  const [state, action, pending] = useActionState(createVendorAction, {});

  return (
    <form action={action} className="grid gap-4 sm:grid-cols-2">
      <Field label="Name" name="name" required placeholder="Auntie Muni's Kitchen" />
      <Field
        label="Phone"
        name="phone"
        required
        type="tel"
        placeholder="+233201234567"
        hint="E.164, including the country code."
      />
      <Select
        label="Location"
        name="location_id"
        defaultValue=""
        options={[
          { value: '', label: '(none)' },
          ...locations
            .filter((l) => l.is_active)
            .map((l) => ({ value: l.id, label: `${l.name} (${l.kind})` })),
        ]}
      />
      <Field
        label="Walk to campus (minutes)"
        name="walk_minutes"
        type="number"
        min="0"
        hint="Leave blank if unknown. Partner offers omit the estimate rather than guessing."
      />
      <div className="sm:col-span-2">
        <Field label="Location note" name="location_note" placeholder="Opposite the main gate" />
      </div>
      <div className="sm:col-span-2">
        <ReasonField placeholder="Recruited in person on 12 Aug" />
      </div>
      <div className="sm:col-span-2">
        <Button disabled={pending}>{pending ? 'Creating…' : 'Create vendor'}</Button>
        <ActionResult state={state} />
      </div>
    </form>
  );
}
