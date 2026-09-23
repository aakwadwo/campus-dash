import Image from 'next/image';
import Link from 'next/link';
import { STAGE, LIVE_STAGES } from './stage';
import { Money, ImagePlaceholder, ChevronRightIcon } from '../ui';

/**
 * One order, in a list. The same row on My orders and on the account screen.
 *
 * A SUMMARY, NOT AN INSTRUCTION MANUAL. The store's photo and name, what was
 * ordered, what it cost, where it stands and when. What to do next (the code
 * at the counter, the Partner's name, the Pay button) belongs on the order
 * itself, one tap away, and is not repeated down the list.
 *
 * A live order is marked by a coloured dot and its stage in the brand colour;
 * a finished one reads as a record, in muted type. `imageUrl` is resolved by
 * the server component that renders the list.
 */
export default function OrderRow({ order, imageUrl = null }) {
  const stage = STAGE[order.stage] ?? { label: order.stage, badge: 'neutral' };
  const live = LIVE_STAGES.has(order.stage);
  const failed = stage.badge === 'bad';

  return (
    <Link
      href={`/orders/${order.order_id}`}
      className="press-sm hover:bg-surface-2 -mx-2 flex items-center gap-3.5 rounded-xl px-2 py-3 transition-colors"
    >
      {imageUrl ? (
        <Image
          src={imageUrl}
          alt=""
          width={56}
          height={56}
          className="rounded-input bg-surface-2 size-14 shrink-0 object-cover"
        />
      ) : (
        <ImagePlaceholder
          name={order.vendor_name}
          ratio="aspect-square"
          className="w-14 shrink-0"
        />
      )}

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <p className="truncate font-semibold">{order.vendor_name}</p>
          <Money pesewas={order.total_pesewas} className="shrink-0 font-semibold" />
        </div>
        {order.items_summary ? (
          <p className="text-muted mt-0.5 truncate text-sm">{order.items_summary}</p>
        ) : null}
        <p className="mt-1 flex items-center gap-1.5 text-xs">
          {live || failed ? (
            <span
              aria-hidden
              className={`size-1.5 shrink-0 rounded-full ${failed ? 'bg-bad' : 'bg-brand-500'}`}
            />
          ) : null}
          <span
            className={
              failed
                ? 'text-bad font-semibold'
                : live
                  ? 'text-brand-700 font-semibold'
                  : 'text-muted'
            }
          >
            {stage.label}
          </span>
          <span className="text-faint">·</span>
          <span className="text-muted">{when(order.completed_at ?? order.submitted_at)}</span>
        </p>
      </div>

      <ChevronRightIcon className="text-faint size-5 shrink-0" />
    </Link>
  );
}

function when(value) {
  if (!value) return '';
  const date = new Date(value);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay
    ? `Today ${date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
    : date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
