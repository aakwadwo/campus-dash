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
        Leave a field blank to leave it unchanged. Fee changes apply to the NEXT order. An order
        already placed keeps the price it was quoted.
      </p>

      {/* FOOD AND SCAN PRICE DIFFERENTLY, and the form says so rather than
          leaving an operator to infer it. Changing the food percentage cannot
          move the scan fee: they are separate columns read by separate pricing
          functions, and price_scan_order() never looks at service_fee_bps. */}
      <h3 className="mt-2 text-sm font-semibold sm:col-span-2">Food orders</h3>
      <Field
        label="Food service fee (basis points, 695 = 6.95% of the food subtotal)"
        name="service_fee_bps"
        type="number"
        placeholder={String(config?.service_fee_bps ?? '')}
        hint="A percentage of what the food costs. Applies to FOOD orders only."
      />

      <h3 className="mt-2 text-sm font-semibold sm:col-span-2">Meal scans</h3>
      <Field
        label="Scan service fee (pesewas, 200 = GH₵2.00, flat)"
        name="scan_service_fee_pesewas"
        type="number"
        placeholder={String(config?.scan_service_fee_pesewas ?? 'not configured')}
        hint="A flat amount per scan order, on collection and Partner orders alike, never a percentage: a scan order has no food value of ours to take a percentage of. Clearing it stops scan ordering rather than making it free."
      />
      {/* SCAN ORDERS ONLY. A normal food order arrives in the store's own
          packaging and is charged nothing for it — the constraint on
          orders.pack_fee_pesewas enforces that, so this cannot leak onto one. */}
      <Field
        label="Disposable pack fee (pesewas)"
        name="scan_pack_fee_pesewas"
        type="number"
        min="0"
        placeholder={String(config?.scan_pack_fee_pesewas ?? 0)}
        hint="SCAN orders only, and its own line on the customer's bill. Optional on a collection — they may bring their own container — and compulsory with a Partner, who needs something to carry. A normal food order comes in the store's packaging and is never charged this. The pack fee is the store's money, allocated to the vendor. 0 means no pack is charged."
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
        hint="Two jobs. A payment with no provider confirmation is failed after this so the customer can retry — and it is also the PAY-BY deadline: an order priced and never paid for is cancelled once it passes, with nothing charged."
      />
      <Field
        label="Minimum payout (pesewas)"
        name="min_payout_pesewas"
        type="number"
        placeholder={String(config?.min_payout_pesewas ?? '')}
        hint="The general floor, used for vendor runs. Below it a payout waits for the next run. 0 disables. Vendors with a Paystack subaccount are settled at the charge and never reach a run at all."
      />
      <Field
        label="Partner weekly payout threshold (pesewas)"
        name="partner_min_payout_pesewas"
        type="number"
        min="0"
        placeholder={String(config?.partner_min_payout_pesewas ?? 2000)}
        hint="2000 = GH₵20. A Partner is paid in the weekly run once their available earnings reach this. Below it the balance is NOT lost: the run releases its claim in the same transaction and the money is carried into the next cycle."
      />
      <Field
        label="Customer screen refresh (seconds)"
        name="customer_poll_seconds"
        type="number"
        placeholder={String(config?.customer_poll_seconds ?? '')}
      />

      {/* CAPACITY. Takes effect on the next acceptance attempt, not on the next
          deploy — partner_accept_delivery() reads this row every time. Lowering
          it never takes an order off a Partner who is already carrying it; they
          come back under the limit by finishing what they have. */}
      <h3 className="mt-2 text-sm font-semibold sm:col-span-2">Partners</h3>
      <Field
        label="Orders one Partner may carry at once"
        name="max_active_deliveries_per_partner"
        type="number"
        min="1"
        max="10"
        placeholder={String(config?.max_active_deliveries_per_partner ?? 2)}
        hint="Default 2. Applies to the next acceptance. Raising it does not reassign anything; lowering it never takes an order off somebody already carrying it."
      />

      {/* THE BIG SWITCH, and the sentence under it is the important part. It
          governs CHECKOUT ONLY. An order somebody has already paid for is their
          dinner and a Partner's GH₵5, and no setting reaches back into it. */}
      <label className="border-line bg-surface-2 rounded-card flex items-start gap-3 border p-3.5 sm:col-span-2">
        <input
          type="checkbox"
          name="partner_delivery_enabled"
          defaultChecked={config?.partner_delivery_enabled !== false}
          className="accent-brand-500 mt-0.5 size-4 shrink-0"
        />
        <span className="text-sm leading-relaxed">
          <span className="font-semibold">Partner delivery is available</span>
          <span className="text-muted block">
            Unticking this removes delivery from the checkout: new customers can only collect.
            Orders already paid for are untouched — nothing is cancelled, reassigned or refunded,
            and Partners carrying deliveries finish them normally.
          </span>
        </span>
      </label>

      <div className="sm:col-span-2">
        <ReasonField placeholder="No Partners are online this evening" />
      </div>
      <div className="sm:col-span-2">
        <Button disabled={saving}>{saving ? 'Saving…' : 'Save settings'}</Button>
        <ActionResult state={state} />
      </div>
    </form>
  );
}
