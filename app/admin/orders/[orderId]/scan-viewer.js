'use client';

import { useActionState } from 'react';
import { viewScanAction } from '../../actions';
import { Button } from '../../ui';

/**
 * Viewing a customer's meal scan.
 *
 * BEHIND A BUTTON ON PURPOSE. The scan is somebody's private document, and an
 * administrator opening an order to check a delivery address should not have it
 * on screen by accident. Pressing this is a deliberate act, and the resulting
 * link is minted per press and expires on its own — there is no permanent URL
 * anywhere in this page, and nothing is embedded until you ask.
 *
 * The authorisation lives in SQL (scan_image_path), not here. This component
 * cannot widen it and gets null if the caller is not entitled.
 */
export default function ScanViewer({ orderId, hasScan }) {
  const [state, view, pending] = useActionState(viewScanAction, {});

  if (!hasScan) {
    return (
      <p className="text-muted text-sm">
        No scan is attached to this order. That is itself worth noting — a scan order cannot be
        created without one.
      </p>
    );
  }

  return (
    <div>
      <form action={view}>
        <input type="hidden" name="order_id" value={orderId} />
        <Button variant="secondary" disabled={pending}>
          {pending ? 'Preparing…' : 'View the scan'}
        </Button>
      </form>

      <p className="text-muted mt-2 text-xs">
        Opens a short-lived private link. It expires on its own, so a copied URL will not keep
        working. Only look if the order actually needs it.
      </p>

      {state?.message && !state.ok ? (
        <p className="mt-3 rounded bg-red-50 px-3 py-2 text-sm text-red-700">{state.message}</p>
      ) : null}

      {state?.ok && state.url ? (
        <div className="mt-3">
          <p className="text-brand-700 mb-2 text-sm font-medium">{state.message}</p>
          {String(state.url).includes('.pdf') ? (
            <a
              href={state.url}
              target="_blank"
              rel="noreferrer"
              className="text-brand-700 text-sm font-semibold underline underline-offset-4"
            >
              Open the scan (PDF) →
            </a>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={state.url}
              alt="The customer's meal scan"
              className="max-w-md rounded ring-1 ring-black/10"
            />
          )}
        </div>
      ) : null}
    </div>
  );
}
