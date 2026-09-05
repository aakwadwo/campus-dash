'use client';

import { useActionState } from 'react';
import { setUserSuspendedAction } from './actions';
import { Field, ActionResult } from './ui';
import { ConfirmButton } from './confirm';

/**
 * Suspend or reinstate one account.
 *
 * SUSPENSION IS OF THE PERSON, NOT OF A ROLE. `users.is_suspended` is the
 * column is_admin(), is_customer(), is_approved_partner() and my_vendor_ids()
 * all consult, so this removes every capability the account holds at once —
 * ordering, delivering, staffing a stall — and reinstatement returns them all
 * at once. It is deliberately NOT the same control as rejecting a Partner
 * application, which withdraws only the Partner capability and leaves somebody
 * perfectly able to buy lunch.
 *
 * ONE DIRECTION PER RENDER. The form posts an explicit "true" or "false" and
 * shows only the action that applies, so an operator is never reading a toggle
 * and inferring which way it is about to go.
 *
 * SELF-SUSPENSION. Hidden here, and refused by admin_set_user_suspended()
 * regardless — is_admin() requires `not is_suspended`, so an administrator
 * suspending themselves revokes the authority to undo it in the same statement.
 * The absence of the button is a courtesy; the database is the control.
 */
export default function AccountSuspension({ userId, name, isSuspended, isSelf, capabilities }) {
  const [state, action, pending] = useActionState(setUserSuspendedAction, {});

  if (isSelf) {
    return (
      <p className="text-muted text-sm">
        This is your own account. An administrator cannot suspend themselves, because is_admin()
        requires an unsuspended account, so it would revoke the access needed to undo it. Ask
        another administrator.
      </p>
    );
  }

  const who = name ?? 'this account';

  return (
    <form action={action} className="grid gap-3 sm:max-w-xl">
      <input type="hidden" name="user_id" value={userId} />
      <input type="hidden" name="suspend" value={isSuspended ? 'false' : 'true'} />

      <p className="text-sm">
        {isSuspended
          ? `${who} is suspended. Reinstating returns every capability the account holds.`
          : `Suspending ${who} refuses ${capabilities ?? 'every capability the account holds'} until it is reinstated.`}
      </p>

      <Field
        label="Reason (recorded in the audit log)"
        name="reason"
        required
        minLength={3}
        placeholder={isSuspended ? 'Investigation closed, no case to answer' : 'Repeated no-shows'}
      />

      <div>
        <ConfirmButton
          variant={isSuspended ? 'secondary' : 'danger'}
          pending={pending}
          pendingLabel="Recording…"
          confirmLabel={isSuspended ? 'Yes, reinstate' : 'Yes, suspend'}
          question={
            isSuspended
              ? `Reinstate ${who}? Ordering, delivering and any vendor access come back immediately.`
              : `Suspend ${who}? They will be signed out of everything they can do (ordering, any delivery in flight, and any stall they staff) until an administrator reinstates them.`
          }
        >
          {isSuspended ? 'Reinstate account' : 'Suspend account'}
        </ConfirmButton>
        <ActionResult state={state} />
      </div>
    </form>
  );
}
