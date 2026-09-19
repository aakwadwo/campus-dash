'use client';

import { useActionState } from 'react';
import StorePhotos from '@/app/store-photos';
import {
  updateProfileAction,
  addImageAction,
  deleteImageAction,
  setPrimaryImageAction,
  savePayoutDestinationAction,
} from '../actions';
import { Button, ErrorNote, Field, Input, Select, Textarea } from '@/app/ui';

function Result({ state }) {
  if (!state?.message) return null;
  if (!state.ok) return <ErrorNote>{state.message}</ErrorNote>;
  return (
    <p className="text-good text-sm font-medium" role="status">
      {state.message}
    </p>
  );
}

/**
 * Where this store's money goes.
 *
 * MOBILE MONEY ONLY, because that is what Paystack settles to in Ghana and
 * inventing a bank-account form for a rail we do not support would produce a
 * store that cannot be paid.
 *
 * THE NUMBER IS NOT ECHOED BACK. Once it is saved the form shows the last three
 * digits and asks for the whole thing again only if the vendor wants to change
 * it. There is nothing here for somebody looking over a shoulder in a busy
 * kitchen to read, and no full account number in the page source.
 */
export function PayoutForm({ vendor, destination }) {
  const [state, action, pending] = useActionState(savePayoutDestinationAction, {});

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="vendor_id" value={vendor.vendor_id} />
      <input type="hidden" name="store_name" value={vendor.name ?? ''} />

      {destination ? (
        <p className="text-muted text-sm">
          Currently paying <strong className="text-ink">{destination.momo_network}</strong> ending{' '}
          <strong className="text-ink">{destination.account_last3}</strong> in the name of{' '}
          {destination.account_name}.
        </p>
      ) : (
        <p className="text-muted text-sm leading-relaxed">
          Add the mobile money account this store is paid into. Until it is set, your share of each
          order is held by Campus Dash and settled by hand.
        </p>
      )}

      <Field label="Network">
        <Select name="momo_network" required defaultValue={destination?.momo_network ?? 'MTN'}>
          <option value="MTN">MTN Mobile Money</option>
          <option value="VODAFONE">Telecel Cash</option>
          <option value="AIRTELTIGO">AirtelTigo Money</option>
        </Select>
      </Field>

      <Field label="Mobile money number" hint="Ten digits, starting 0. For example 0551234567.">
        <Input
          name="account_number"
          required
          inputMode="numeric"
          autoComplete="off"
          placeholder={destination ? `Ends ${destination.account_last3}` : '0551234567'}
        />
      </Field>

      <Field label="Name on the account" hint="Exactly as it is registered with the network.">
        <Input name="account_name" required defaultValue={destination?.account_name ?? ''} />
      </Field>

      <Button type="submit" disabled={pending}>
        {pending ? 'Saving…' : destination ? 'Update payout details' : 'Save payout details'}
      </Button>
      <Result state={state} />
    </form>
  );
}

export function StoreDetailsForm({ vendor, categories, locations }) {
  const [state, action, pending] = useActionState(updateProfileAction, {});

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="vendor_id" value={vendor.vendor_id} />

      <Field label="Store name">
        <Input name="name" required defaultValue={vendor.name ?? ''} />
      </Field>

      <Field label="What you sell">
        <Textarea name="description" rows={3} defaultValue={vendor.description ?? ''} />
      </Field>

      <Field label="Category">
        <Select name="category_id" defaultValue={vendor.category_id ?? ''}>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Where you are" hint="The campus point students would walk to.">
        <Select name="location_id" defaultValue={vendor.location_id ?? ''}>
          <option value="">Not set</option>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Directions" hint="Anything a Partner needs to find you. Optional.">
        <Input name="location_note" defaultValue={vendor.location_note ?? ''} />
      </Field>

      <Field label="Walk to campus (minutes)" hint="Used to estimate delivery time. Optional.">
        <Input
          name="walk_minutes"
          type="number"
          min="0"
          defaultValue={vendor.walk_minutes_to_campus ?? ''}
        />
      </Field>

      <Button type="submit" disabled={pending}>
        {pending ? 'Saving…' : 'Save details'}
      </Button>
      <Result state={state} />
    </form>
  );
}

/** The store's photos, through the component the admin console uses too. */
export function ImageForms({ vendorId, images }) {
  return (
    <StorePhotos
      vendorId={vendorId}
      images={images}
      addAction={addImageAction}
      removeAction={deleteImageAction}
      primaryAction={setPrimaryImageAction}
    />
  );
}
