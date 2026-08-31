'use client';

import { useActionState } from 'react';
import { updateConfigAction } from '../actions';
import { Field, ReasonField, Button, ActionResult } from '../ui';

/**
 * Blank means "leave alone", so an operator changing one fee cannot
 * accidentally reset a timeout they never looked at.
 */
export default function ConfigForm({ config }) {
  const [state, save, saving] = useActionState(updateConfigAction, {});

  return (
    <form action={save} className="grid gap-4 sm:grid-cols-2">
      <p className="text-muted text-xs sm:col-span-2">
        Leave a field blank to leave it unchanged. Fee changes apply to the NEXT order — an order
        already placed keeps the price it was quoted.
      </p>

      <Field
        label="Service fee (pesewas)"
        name="service_fee_pesewas"
        type="number"
        placeholder={String(config?.service_fee_pesewas ?? '')}
      />
      <Field
        label="Delivery fee (pesewas)"
        name="delivery_fee_pesewas"
        type="number"
        placeholder={String(config?.delivery_fee_pesewas ?? '')}
      />
      <Field
        label="Vendor answer window (seconds)"
        name="vendor_response_seconds"
        type="number"
        placeholder={String(config?.vendor_response_seconds ?? '')}
        hint="How long a stall has to accept before the order expires."
      />
      <Field
        label="Partner search window (seconds)"
        name="partner_search_seconds"
        type="number"
        placeholder={String(config?.partner_search_seconds ?? '')}
        hint="After this the customer is offered a choice; the food is never cancelled."
      />
      <Field
        label="Customer absence wait (seconds)"
        name="customer_absent_wait_seconds"
        type="number"
        placeholder={String(config?.customer_absent_wait_seconds ?? '')}
        hint="How long a Partner must wait after reporting no answer."
      />
      <Field
        label="Payment timeout (seconds)"
        name="payment_pending_timeout_seconds"
        type="number"
        placeholder={String(config?.payment_pending_timeout_seconds ?? '')}
        hint="After this a payment with no provider confirmation is failed so the customer can retry."
      />
      <Field
        label="Minimum payout (pesewas)"
        name="min_payout_pesewas"
        type="number"
        placeholder={String(config?.min_payout_pesewas ?? '')}
        hint="Below this a payout waits for the next run. 0 disables."
      />
      <Field
        label="Customer screen refresh (seconds)"
        name="customer_poll_seconds"
        type="number"
        placeholder={String(config?.customer_poll_seconds ?? '')}
      />

      <div className="sm:col-span-2">
        <ReasonField placeholder="Vendors said 60 seconds was too short at lunchtime" />
      </div>
      <div className="sm:col-span-2">
        <Button disabled={saving}>{saving ? 'Saving…' : 'Save settings'}</Button>
        <ActionResult state={state} />
      </div>
    </form>
  );
}
