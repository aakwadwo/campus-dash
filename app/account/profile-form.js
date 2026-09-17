'use client';

import { useActionState, useState } from 'react';
import { saveMyProfile } from './actions';
import { Button, ErrorNote, Field, Input, Select } from '@/app/ui';
import { graduationYears } from '@/lib/auth/customer-signup';

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
export default function ProfileForm({
  firstName,
  lastName,
  phone,
  phoneIsCredential = false,
  isCustomer = false,
  affiliation = 'STUDENT',
  graduationYear = null,
  gender = null,
}) {
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

      {/* THE CUSTOMER FACTS, and only for somebody who has them. A vendor-only
          or admin account holds no customer_profiles row, and update_my_profile()
          refuses to invent one — granting the CUSTOMER capability from a
          settings form would be a capability escalation with a text input. */}
      {isCustomer ? (
        <WhoYouAre affiliation={affiliation} graduationYear={graduationYear} gender={gender} />
      ) : null}

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

/**
 * Student or staff, and what follows from each.
 *
 * A GRADUATION YEAR RATHER THAN A LEVEL, for the reason the sign-up form gives:
 * a level is wrong for three of the four years it describes, because nobody
 * comes back in September to move themselves up.
 */
function WhoYouAre({ affiliation, graduationYear, gender }) {
  const [who, setWho] = useState(affiliation ?? 'STUDENT');
  // THE SAME FOUR YEARS SIGN-UP OFFERS, from the same array, because this
  // screen writes the same column through the same validation.
  const years = graduationYears();

  return (
    <>
      <fieldset>
        <legend className="mb-2 text-sm font-medium">Student or staff</legend>
        <div className="grid max-w-sm grid-cols-2 gap-2.5">
          {[
            ['STUDENT', 'Student'],
            ['STAFF', 'Staff'],
          ].map(([value, label]) => (
            <label
              key={value}
              className={`rounded-card press flex min-h-11 cursor-pointer items-center justify-center border text-sm font-semibold transition-colors ${
                who === value
                  ? 'border-brand-600 bg-brand-50 ring-brand-600/25 ring-1'
                  : 'border-line-strong hover:bg-surface-2'
              }`}
            >
              <input
                type="radio"
                name="affiliation"
                value={value}
                checked={who === value}
                onChange={() => setWho(value)}
                className="sr-only"
              />
              {label}
            </label>
          ))}
        </div>
      </fieldset>

      {who === 'STUDENT' ? (
        <Field label="Expected graduation" hint="So we never have to ask again.">
          {/* EXACTLY THE FOUR OFFERED YEARS. An account carrying an older year
              — one written before the list was fixed — matches none of them, so
              the disabled placeholder is what shows and the field has to be
              answered before the form will submit. Offering the stale year back
              would offer a value update_my_profile() now refuses. */}
          <Select name="graduation_year" required defaultValue={graduationYear ?? ''}>
            <option value="" disabled>
              Choose a year
            </option>
            {years.map((year) => (
              <option key={year} value={year}>
                {year}
              </option>
            ))}
          </Select>
        </Field>
      ) : (
        <input type="hidden" name="graduation_year" value="" />
      )}

      {/* MALE OR FEMALE. "Prefer not to say" stored a null, and a column that
          cannot be counted is a column with no reason to be asked for. */}
      <Field label="Gender">
        <Select name="gender" required defaultValue={gender ?? ''}>
          <option value="" disabled>
            Choose
          </option>
          <option value="MALE">Male</option>
          <option value="FEMALE">Female</option>
        </Select>
      </Field>
    </>
  );
}
