'use client';

import { useActionState, useOptimistic } from 'react';
import { setMenuItemAvailableAction } from '../actions';
import { formatPesewas } from '@/lib/util/money';

/**
 * Sold out, or on.
 *
 * ONE FORM PER ROW, each with its own pending state, so marking the jollof sold
 * out does not grey out the waakye. The row flips OPTIMISTICALLY — this is a
 * boolean the server always accepts for an item the vendor owns, and the whole
 * point of the screen is that it keeps up with a counter. If the write does
 * fail, the row snaps back and says why.
 */
export default function MenuAvailability({ vendorId, menu }) {
  if (menu.length === 0) {
    return <p className="text-muted text-sm">No items yet.</p>;
  }

  return (
    <ul className="divide-line divide-y">
      {menu.map((item) => (
        <li key={item.id}>
          <Row item={item} vendorId={vendorId} />
        </li>
      ))}
    </ul>
  );
}

function Row({ item, vendorId }) {
  const [state, submit, pending] = useActionState(setMenuItemAvailableAction, {});
  // The server value is the truth; this only leads it by the length of one
  // round trip, and is reconciled the moment the response lands.
  const [available, setOptimistic] = useOptimistic(item.is_available);

  return (
    <div className="flex items-center gap-4 py-3.5">
      <div className="min-w-0 flex-1">
        <p className={`font-medium ${available ? '' : 'text-muted'}`}>{item.name}</p>
        <p className="text-muted mt-0.5 text-sm tabular-nums">
          {formatPesewas(item.price_pesewas)}
          {available ? null : <span className="ml-2 font-semibold">· Sold out</span>}
        </p>
        {state.message && !state.ok ? (
          <p role="alert" className="text-bad mt-1 text-sm">
            {state.message}
          </p>
        ) : null}
      </div>

      <form
        action={(formData) => {
          setOptimistic(!available);
          submit(formData);
        }}
        className="shrink-0"
      >
        <input type="hidden" name="menu_item_id" value={item.id} />
        <input type="hidden" name="vendor_id" value={vendorId} />
        <input type="hidden" name="name" value={item.name} />
        <input type="hidden" name="available" value={available ? 'false' : 'true'} />
        <button
          type="submit"
          disabled={pending}
          aria-label={available ? `Mark ${item.name} sold out` : `Put ${item.name} back on`}
          className={`press h-10 min-w-28 rounded-full px-4 text-sm font-semibold transition-colors disabled:opacity-60 ${
            available ? 'text-ink bg-surface ring-line-strong ring-1' : 'bg-brand-700 text-white'
          }`}
        >
          {pending ? '…' : available ? 'Mark sold out' : 'Put back on'}
        </button>
      </form>
    </div>
  );
}
