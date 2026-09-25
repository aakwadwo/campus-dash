'use client';

import { useActionState } from 'react';
import { setVendorOpenAction } from '../../actions';
import { ReasonField, Button, ActionResult } from '../../ui';

/**
 * Closing or reopening a store, as an administrator.
 *
 * THE SAME OPEN SIGN THE STORE USES. Closing turns the active menu off, as the
 * store's own Close does, and keeps the catalogue. Reopening puts back what
 * that close turned off, and the database refuses it once the menu has been
 * edited since. Only an ACTIVE store is offered either: a suspended one is
 * closed by its status and reinstated from the status control below.
 */
export default function VendorOpenForm({ vendor }) {
  const [state, action, pending] = useActionState(setVendorOpenAction, {});

  if (vendor.status !== 'ACTIVE') {
    return (
      <p className="text-muted text-sm">
        Closed by its status. Only an ACTIVE store can be opened or closed.
      </p>
    );
  }

  const open = vendor.is_accepting_orders;
  return (
    <form action={action} className="grid gap-4 sm:grid-cols-2">
      <input type="hidden" name="vendor_id" value={vendor.id} />
      <input type="hidden" name="open" value={open ? 'false' : 'true'} />
      <p className="text-muted text-sm sm:col-span-2">
        {open
          ? 'Open for orders. Closing turns its menu off, exactly as the store closing itself does. Orders already placed carry on.'
          : 'Closed. Reopening puts back the items an administrator close turned off. If the store has changed its menu since, it opens itself by turning an item on.'}
      </p>
      <ReasonField
        placeholder={open ? 'Store unattended during service' : 'Owner confirmed they are back'}
      />
      <div className="sm:col-span-2">
        <Button variant={open ? 'secondary' : 'primary'} disabled={pending}>
          {pending ? 'Saving…' : open ? 'Close store' : 'Reopen store'}
        </Button>
        <ActionResult state={state} />
      </div>
    </form>
  );
}
