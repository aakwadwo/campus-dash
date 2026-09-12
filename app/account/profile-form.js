'use client';

import { useActionState } from 'react';
import { saveMyProfile } from './actions';
import { Button, ErrorNote, Field, Input } from '@/app/ui';

/**
 * Name, and the number a Partner rings.
 *
 * TWO NAME FIELDS BECAUSE THE PRODUCT NEEDS THE FIRST ONE ON ITS OWN. "Kwame
 * has accepted your order" is what a customer should read, and no amount of
 * splitting a single "full name" string afterwards gets that right for
 * everybody. Asking is cheaper and correct.
 *
 * The phone field is absent for anyone who signs in with it. A store owner's
 * number is their credential; the database refuses to move it from here, and
 * offering a field that will be refused is worse than not offering one.
 */
export default function ProfileForm({ firstName, lastName, phone, phoneIsCredential = false }) {
  const [state, save, saving] = useActionState(saveMyProfile, {});

  return (
    <form action={save} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="First name">
          <Input
            name="first_name"
            autoComplete="given-name"
            required
            defaultValue={firstName ?? ''}
          />
        </Field>
        <Field label="Last name">
          <Input name="last_name" autoComplete="family-name" defaultValue={lastName ?? ''} />
        </Field>
      </div>

      {phoneIsCredential ? (
        <Field
          label="Phone number"
          hint="This is how you sign in. Contact Campus Dash to change it."
        >
          <Input value={phone ?? ''} readOnly disabled />
        </Field>
      ) : (
        <Field label="Phone number" hint="The number a Partner rings when they reach your door.">
          <Input
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="020 123 4567"
            defaultValue={phone ?? ''}
          />
        </Field>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="secondary" disabled={saving}>
          {saving ? 'Saving…' : 'Save changes'}
        </Button>
        {state.ok ? (
          <span role="status" className="text-good text-sm font-semibold">
            Saved.
          </span>
        ) : null}
      </div>

      {state.message && !state.ok ? <ErrorNote>{state.message}</ErrorNote> : null}
    </form>
  );
}
