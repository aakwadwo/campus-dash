'use client';

import { useActionState } from 'react';
import { purgePartnerDocumentsAction } from '../../actions';
import { Field, ActionResult } from '../../ui';
import { ConfirmButton } from '../../confirm';

/**
 * Deletes a Partner's verification documents, permanently.
 *
 * THE FORM POSTS NO PATHS. purgePartnerDocuments() reads what this Partner
 * actually has on file and deletes exactly that, so a tampered hidden field
 * cannot aim the deletion at somebody else's image.
 *
 * Irreversible and unrecoverable — the storage objects are removed and the
 * columns cleared in the same operation, and re-verifying means asking the
 * person for a new photograph. That is why it is behind a confirmation as well
 * as a reason.
 */
export default function PurgeDocumentsForm({ userId, name, hasDocuments }) {
  const [state, action, pending] = useActionState(purgePartnerDocumentsAction, {});

  if (!hasDocuments) {
    return (
      <p className="text-muted text-sm">
        No verification documents are on file for this Partner. Nothing to delete.
      </p>
    );
  }

  return (
    <form action={action} className="grid gap-3 sm:max-w-xl">
      <input type="hidden" name="user_id" value={userId} />
      <p className="text-sm">
        Deletes the student ID photograph, and the face photograph if this Partner applied while
        Campus Dash still asked for one.
      </p>
      <Field
        label="Reason (recorded in the audit log)"
        name="reason"
        required
        minLength={3}
        placeholder="Retention period elapsed"
      />
      <div>
        <ConfirmButton
          pending={pending}
          pendingLabel="Deleting…"
          confirmLabel="Yes, delete permanently"
          question={`Permanently delete the verification documents for ${name}? They cannot be recovered, and re-verifying means asking for new ones.`}
        >
          Delete verification documents
        </ConfirmButton>
        <ActionResult state={state} />
      </div>
    </form>
  );
}
