'use client';

import { useState } from 'react';
import { Field, Input, SegmentedOption } from '@/app/ui';
import { LOCATION_AREAS, LOCATION_DETAILS_MAX } from '@/lib/util/vendor-location';

/**
 * On or off campus, then where exactly.
 *
 * The same two questions at registration and on the Store page. The example
 * under the text box follows the choice above it, because "near the Student
 * Centre" is no help to a kitchen in East Legon Hills. The examples are
 * placeholders, never values: nothing is saved that the vendor did not type.
 */
export default function VendorLocationFields({ area = '', details = '' }) {
  const [chosen, setChosen] = useState(area ?? '');
  const example = LOCATION_AREAS.find((a) => a.value === chosen)?.placeholder;

  return (
    <>
      <fieldset>
        <legend className="mb-1.5 block text-sm font-medium">Where is your store?</legend>
        <div className="flex gap-2">
          {LOCATION_AREAS.map((option) => (
            <SegmentedOption
              key={option.value}
              name="location_area"
              value={option.value}
              checked={area === option.value}
              onChange={() => setChosen(option.value)}
            >
              {option.label}
            </SegmentedOption>
          ))}
        </div>
      </fieldset>

      <Field
        label="Store location"
        hint="Be specific enough that a student could walk to you. Customers see this under your store name."
      >
        <Input
          name="location_details"
          required
          maxLength={LOCATION_DETAILS_MAX}
          defaultValue={details ?? ''}
          placeholder={example ?? 'Choose on or off campus first'}
        />
      </Field>
    </>
  );
}
