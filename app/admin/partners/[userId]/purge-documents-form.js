'use client';

import { useActionState } from 'react';
import { purgePartnerDocumentsAction } from '../../actions';
import { Field, ActionResult } from '../../ui';
import { ConfirmButton } from '../../confirm';

/**
 * Deletes the Partner's live face photograph, permanently.
 *
 * THE FACE PHOTOGRAPH ONLY. The student ID belongs to the CUSTOMER profile and
 * is the evidence for a capability the person still holds; purgePartnerDocuments
 * re-derives the one path it is allowed to delete server-side and ignores
 * anything else, so this form deliberately posts no path at all.
 *
 * Irreversible and unrecoverable — the storage object is removed and the column
 * cleared in the same operation, and re-verification means asking the person for
 * a new photograph. That is why it is behind a confirmation as well as a reason.
 */
export default function PurgeDocumentsForm({ userId, name, hasFaceImage }) {
  const [state, action, pending] = useActionState(purgePartnerDocumentsAction, {});

  if (!hasFaceImage) {
    return (
      <p className="text-muted text-sm">
        No verification photograph is on file for this Partner. Nothing to delete.
      </p>
    );
  }

  return (
    <form action={action} className="grid gap-3 sm:max-w-xl">
      <input type="hidden" name="user_id" value={userId} />
      <p className="text-sm">
        Deletes the live face photograph taken at application. The student ID photograph is not
        touched — it belongs to the Customer record.
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
          question={`Permanently delete the verification photograph for ${name}? It cannot be recovered, and re-verifying means asking them for a new one.`}
        >
          Delete verification photograph
        </ConfirmButton>
        <ActionResult state={state} />
      </div>
    </form>
  );
}
