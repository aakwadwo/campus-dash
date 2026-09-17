'use client';

import { useActionState } from 'react';
import { deleteCustomerAction } from '../../actions';
import { Field, ActionResult } from '../../ui';
import { ConfirmButton } from '../../confirm';

/**
 * Removes an account that never got started.
 *
 * THE SAME RULE AS A STORE, for the same reason: an account that has ordered
 * has money records behind those orders, so admin_delete_customer() refuses it
 * and suspension is the control instead. What this is for is the sign-up that
 * should not have happened — a wrong address, a duplicate, a test.
 *
 * It removes every capability row built on the identity, in the order the
 * foreign keys require, and the verification documents in storage with them.
 */

/**
 * The refusal this account would get, said BEFORE the button rather than after
 * it.
 *
 * admin_delete_customer() refuses the caller, an administrator, a store owner,
 * and anybody with an order, a settlement record or a rating. Four of those are
 * already in the data this page loaded, so where the answer is known the form
 * is not offered at all — an admin should not be given a control whose only
 * possible outcome is a refusal.
 *
 * THIS IS NOT THE ENFORCEMENT. The database re-checks every one of these, plus
 * the settlement and rating cases that are not visible here, and it is still
 * the thing that decides. This only stops the pointless press.
 */
function refusalFor({ isSelf, isAdmin, storeNames, orderCount, who }) {
  if (isSelf) {
    return 'This is your own account. An administrator cannot delete themselves — the audit trail keys off the administrator row, so removing one would cost every action it records its author.';
  }
  if (isAdmin) {
    return 'This is an administrator account. The audit trail keys off the administrator row, so it cannot be deleted here.';
  }
  if (storeNames.length > 0) {
    return `${who} owns ${storeNames.join(', ')}. Delete the store first. The account goes with it if the store turns out to be the only thing it held.`;
  }
  if (orderCount > 0) {
    return `This account cannot be deleted because it has order or financial history: ${orderCount} order${orderCount === 1 ? '' : 's'}. The payment and settlement records behind them are what reconcile the money. Suspend the account instead.`;
  }
  return null;
}

export default function DeleteCustomerForm({
  userId,
  name,
  isSelf,
  orderCount = 0,
  isAdmin = false,
  storeNames = [],
}) {
  const [state, action, pending] = useActionState(deleteCustomerAction, {});

  const who = name ?? 'this account';
  const refusal = refusalFor({ isSelf, isAdmin, storeNames, orderCount, who });

  if (refusal) return <p className="text-muted text-sm">{refusal}</p>;

  return (
    <form action={action} className="grid gap-3 sm:max-w-xl">
      <input type="hidden" name="user_id" value={userId} />

      <p className="text-sm">
        Deleting {who} removes the account, its customer profile, any Partner application and the
        documents uploaded with it. This cannot be undone.
      </p>

      <Field
        label="Reason (recorded in the audit log)"
        name="reason"
        required
        minLength={3}
        placeholder="Duplicate sign-up, wrong address"
      />

      <div>
        <ConfirmButton
          pending={pending}
          pendingLabel="Deleting…"
          confirmLabel="Yes, delete it"
          question={`Delete ${who}? Every capability on this identity goes with it, and this cannot be undone.`}
        >
          Delete this account
        </ConfirmButton>
        <ActionResult state={state} />
      </div>
    </form>
  );
}
