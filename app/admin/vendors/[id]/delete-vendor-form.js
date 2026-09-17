'use client';

import { useActionState } from 'react';
import { deleteVendorAction } from '../../actions';
import { Field, ActionResult } from '../../ui';
import { ConfirmButton } from '../../confirm';

/**
 * Removes a store that never traded.
 *
 * WHY THERE IS NO "DELETE ANYWAY". A store with orders against it has money
 * records hanging off those orders, and deleting them would leave the books
 * short with an audit row naming whoever pressed this. admin_delete_vendor()
 * refuses it and says how many orders there are; the control for a store that
 * has traded is SUSPENSION, which takes it off the marketplace and keeps the
 * history. A genuine pilot reset is scripts/purge-test-accounts, which runs as
 * the database owner and is deliberately not reachable from a browser.
 *
 * The owner's account goes with the store only if the store was the only thing
 * it held. Somebody who also orders lunch keeps their account and simply stops
 * having a store.
 */
export default function DeleteVendorForm({ vendor, hasOwner, orderCount = 0 }) {
  const [state, action, pending] = useActionState(deleteVendorAction, {});

  return (
    <form action={action} className="grid gap-3 sm:max-w-xl">
      <input type="hidden" name="vendor_id" value={vendor.id} />

      <p className="text-sm">
        {orderCount > 0
          ? `${vendor.name} has ${orderCount} order${orderCount === 1 ? '' : 's'} against it, so it cannot be deleted. Set the status to SUSPENDED instead — it comes off the marketplace and the records stay.`
          : `Deleting ${vendor.name} removes its menu, its photographs and its daily queue counter.${hasOwner ? ' The owner’s account goes too, unless it also orders or carries deliveries.' : ''} This cannot be undone.`}
      </p>

      <Field
        label="Reason (recorded in the audit log)"
        name="reason"
        required
        minLength={3}
        placeholder="Created by mistake during setup"
      />

      <div>
        <ConfirmButton
          pending={pending}
          pendingLabel="Deleting…"
          confirmLabel="Yes, delete it"
          question={`Delete ${vendor.name}? Its menu, photographs and queue counter go with it, and this cannot be undone.`}
        >
          Delete this store
        </ConfirmButton>
        <ActionResult state={state} />
      </div>
    </form>
  );
}
