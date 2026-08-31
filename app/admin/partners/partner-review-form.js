'use client';

import { useActionState } from 'react';
import { reviewPartnerAction } from '../actions';
import { Field, Select, ReasonField, Button, ActionResult } from '../ui';

export default function PartnerReviewForm({ userId, current }) {
  const [state, action, pending] = useActionState(reviewPartnerAction, {});

  return (
    <form action={action} className="grid gap-3 sm:grid-cols-4">
      <input type="hidden" name="user_id" value={userId} />
      <Select
        label="Decision"
        name="status"
        required
        defaultValue={current === 'PENDING_REVIEW' ? 'APPROVED' : current}
        options={[
          { value: 'APPROVED', label: 'Approve' },
          { value: 'REJECTED', label: 'Reject' },
          { value: 'SUSPENDED', label: 'Suspend' },
        ]}
      />
      <div className="sm:col-span-2">
        <ReasonField placeholder="Face matches the student ID" />
      </div>
      <Field label="Notes (optional)" name="notes" placeholder="Verified in person" />
      <div className="sm:col-span-4">
        <Button disabled={pending}>{pending ? 'Recording…' : 'Record decision'}</Button>
        <ActionResult state={state} />
      </div>
    </form>
  );
}
