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
export default function DeleteCustomerForm({ userId, name, isSelf, orderCount = 0 }) {
  const [state, action, pending] = useActionState(deleteCustomerAction, {});

  if (isSelf) {
    return (
      <p className="text-muted text-sm">
        This is your own account. An administrator cannot delete themselves — the audit trail keys
        off the administrator row, so removing one would cost every action it records its author.
      </p>
    );
  }

  const who = name ?? 'this account';

  return (
    <form action={action} className="grid gap-3 sm:max-w-xl">
      <input type="hidden" name="user_id" value={userId} />

      <p className="text-sm">
        {orderCount > 0
          ? `${who} has ${orderCount} order${orderCount === 1 ? '' : 's'}, so the account cannot be deleted — the payment and settlement records behind them are what reconcile the money. Suspend it instead.`
          : `Deleting ${who} removes the account, its customer profile, any Partner application and the documents uploaded with it. This cannot be undone.`}
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
