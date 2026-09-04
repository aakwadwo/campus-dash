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

      {/* FOOD AND SCAN PRICE DIFFERENTLY, and the form says so rather than
          leaving an operator to infer it. Changing the food percentage cannot
          move the scan fee: they are separate columns read by separate pricing
          functions, and price_scan_order() never looks at service_fee_bps. */}
      <h3 className="mt-2 text-sm font-semibold sm:col-span-2">Food orders</h3>
      <Field
        label="Food service fee (basis points — 500 = 5% of the food subtotal)"
        name="service_fee_bps"
        type="number"
        placeholder={String(config?.service_fee_bps ?? '')}
        hint="A percentage of what the food costs. Applies to FOOD orders only."
      />

      <h3 className="mt-2 text-sm font-semibold sm:col-span-2">Scan delivery</h3>
      <Field
        label="Scan service fee (pesewas — 200 = GH₵2.00, flat)"
        name="scan_service_fee_pesewas"
        type="number"
        placeholder={String(config?.scan_service_fee_pesewas ?? 'not configured')}
        hint="A flat amount per errand, never a percentage — a scan order has no food value to take a percentage of. Clearing it stops scan ordering rather than making it free."
      />

      <h3 className="mt-2 text-sm font-semibold sm:col-span-2">Both order types</h3>
      <Field
        label="Delivery fee (pesewas)"
        name="delivery_fee_pesewas"
        type="number"
        placeholder={String(config?.delivery_fee_pesewas ?? '')}
        hint="Charged on every delivery, food or scan. The Partner's share of it is set separately."
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
