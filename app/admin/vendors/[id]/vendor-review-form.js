'use client';

import { useActionState, useState } from 'react';
import { reviewVendorAction } from '../../actions';
import { ReasonField, Button, ActionResult } from '../../ui';

/**
 * Approve or reject a store application.
 *
 * REJECTION REQUIRES A REASON, and the reason goes to the applicant — not just
 * to the audit log. A rejection somebody cannot read is a dead end rather than
 * a decision, and this flow is built around them correcting it and resubmitting.
 *
 * Approval does NOT open the store. It grants the capability; opening for
 * orders is the vendor's own decision, made when they are behind the counter.
 */
export default function VendorReviewForm({ vendor }) {
  const [state, action, pending] = useActionState(reviewVendorAction, {});
  const [decision, setDecision] = useState('APPROVE');

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="vendor_id" value={vendor.id} />
      <input type="hidden" name="decision" value={decision} />

      <div className="flex gap-2">
        {[
          ['APPROVE', 'Approve'],
          ['REJECT', 'Reject'],
        ].map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setDecision(value)}
            className={`rounded-full border px-4 py-2 text-sm font-semibold ${
              decision === value
                ? value === 'APPROVE'
                  ? 'bg-brand-700 border-brand-700 text-white'
                  : 'border-bad bg-bad/10 text-bad'
                : 'border-line bg-surface text-muted'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <ReasonField
        placeholder={
          decision === 'APPROVE'
            ? 'Visited the store, documents checked'
            : 'The store name and the description do not match. Resubmit with the real trading name.'
        }
      />
      <p className="text-muted text-xs leading-relaxed">
        {decision === 'APPROVE'
          ? 'The owner is texted a link to their Vendor Dashboard. The store stays CLOSED until they open it themselves.'
          : 'This reason is shown to the applicant so they can correct it and resubmit. Write it for them, not for the log.'}
      </p>

      <Button pending={pending} variant={decision === 'APPROVE' ? 'primary' : 'danger'}>
        {pending ? 'Saving…' : decision === 'APPROVE' ? 'Approve store' : 'Reject application'}
      </Button>
      <ActionResult state={state} />
    </form>
  );
}
