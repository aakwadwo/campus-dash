'use client';

import { useActionState } from 'react';
import { createVendorAccountAction } from '../actions';
import { Field, Select, ReasonField, Button, ActionResult } from '../ui';

/**
 * A store WITH an account, for a vendor recruited in person.
 *
 * THE SAME FIELDS /vendor/signup ASKS FOR, because it is the same application:
 * who the applicant is, what the store is called, whether they are a student,
 * what they sell and which category it files under. An administrator takes them
 * at the counter instead of the owner typing them at home.
 *
 * IT DOES NOT APPROVE ANYTHING. The store is created PENDING_APPROVAL and the
 * existing review form on its own page is what makes it ACTIVE — which is also
 * what sends the owner their welcome message. Creating a store and approving it
 * are two decisions and they stay two audit rows.
 */
export default function CreateVendorAccountForm({ locations, categories = [] }) {
  const [state, action, pending] = useActionState(createVendorAccountAction, {});

  return (
    <form action={action} className="grid gap-4 sm:grid-cols-2">
      <Field label="Store name" name="name" required placeholder="Auntie Muni's Kitchen" />
      <Field
        label="Owner's phone"
        name="phone"
        required
        type="tel"
        placeholder="020 123 4567"
        hint="This is how the owner signs in. If Campus Dash already knows this number, the store is attached to that account."
      />
      <Field label="Owner's name" name="applicant_name" placeholder="Kofi Mensah" />
      <Select
        label="Is the owner a student?"
        name="owner_is_student"
        defaultValue="no"
        options={[
          { value: 'no', label: 'No' },
          { value: 'yes', label: 'Yes' },
        ]}
      />
      <Select
        label="Category"
        name="category_id"
        defaultValue=""
        options={[
          { value: '', label: 'Meals & Food (default)' },
          ...categories.map((c) => ({ value: c.id, label: c.name })),
        ]}
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
      <Field label="Location note" name="location_note" placeholder="Opposite the main gate" />
      <div className="sm:col-span-2">
        <Field
          label="What the store sells"
          name="description"
          placeholder="Waakye, jollof and grilled chicken"
        />
      </div>
      <div className="sm:col-span-2">
        <ReasonField placeholder="Recruited in person on 12 Aug" />
      </div>
      <div className="sm:col-span-2">
        <Button disabled={pending} pending={pending}>
          Create vendor account
        </Button>
        <ActionResult state={state} />
      </div>
    </form>
  );
}
