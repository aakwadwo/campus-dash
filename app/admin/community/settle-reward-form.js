'use client';

import { useActionState } from 'react';
import { settleCustomerRewardAction } from '../actions';
import { Field, ActionResult, Button } from '../ui';

/**
 * Records what a customer was actually given.
 *
 * The note is required, because "settled" with no note is a row that proves
 * nothing three months later — and this is the only record that a reward was
 * honoured.
 */
export default function SettleRewardForm({ rewardId, name }) {
  const [state, action, pending] = useActionState(settleCustomerRewardAction, {});

  return (
    <form action={action} className="mt-3 flex flex-wrap items-end gap-3">
      <input type="hidden" name="reward_id" value={rewardId} />
      <div className="min-w-64 flex-1">
        <Field
          label={`What ${name?.split(' ')[0] ?? 'they'} was given`}
          name="notes"
          required
          minLength={3}
          placeholder="Free lunch at Muni, 12 March"
        />
      </div>
      <Button disabled={pending}>{pending ? 'Saving…' : 'Mark as given'}</Button>
      <ActionResult state={state} />
    </form>
  );
}
