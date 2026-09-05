'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { setAcceptingOrdersAction } from '../actions';
import { formatPesewas } from '@/lib/util/money';

/**
 * The vendor's whole day on one screen.
 *
 * Designed for a phone propped next to a hot plate: four clearly separated
 * groups, large touch targets, and the order nearest its deadline at the top of
 * the list that needs attention.
 */
const GROUPS = [
  {
    key: 'NEW',
    title: 'New: needs your answer',
    tone: 'border-warn/40 bg-warn-bg',
    dot: 'bg-warn',
  },
  {
    key: 'PREPARING',
    title: 'Preparing',
    tone: 'border-brand-600/40 bg-brand-50',
    dot: 'bg-brand-600',
  },
  { key: 'READY', title: 'Ready', tone: 'border-brand-600 bg-brand-100', dot: 'bg-brand-700' },
  { key: 'CLOSED', title: 'Finished today', tone: 'border-line bg-surface', dot: 'bg-black/20' },
];

export default function OrderBoard({ vendor, buckets, initialPending, pollMs = 8000 }) {
  const router = useRouter();
  const [openState, toggleOpen, toggling] = useActionState(setAcceptingOrdersAction, {});
  const pending = buckets.NEW.length;

  useNewOrderAlert({
    vendorId: vendor.id,
    pending,
    initialPending,
    onChange: () => router.refresh(),
  });

  return (
    <main className="mx-auto max-w-2xl px-4 pt-4 pb-16">
      <header className="mb-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">{vendor.name}</h1>
            <p className="text-muted text-sm">
              {vendor.is_accepting_orders ? 'Open for orders' : 'Closed to new orders'}
            </p>
          </div>
          <form action={toggleOpen}>
            <input type="hidden" name="vendor_id" value={vendor.id} />
            <input
              type="hidden"
              name="accepting"
              value={vendor.is_accepting_orders ? 'false' : 'true'}
            />
            <button
              type="submit"
              disabled={toggling}
              className={`rounded-full px-4 py-2 text-sm font-semibold ${
                vendor.is_accepting_orders
                  ? 'text-ink bg-surface ring-line-strong ring-1'
                  : 'bg-brand-500 text-ink'
              }`}
            >
              {vendor.is_accepting_orders ? 'Close stall' : 'Open stall'}
            </button>
          </form>
        </div>
        {openState.message ? (
          <p className={`mt-2 text-sm ${openState.ok ? 'text-brand-700' : 'text-bad'}`}>
            {openState.message}
          </p>
        ) : null}
      </header>

      {pending > 0 ? (
        <p
          role="alert"
          className="press bg-warn-bg text-warn mb-4 rounded-full px-4 py-3 text-sm font-semibold transition-colors"
        >
          {pending === 1 ? '1 new order is waiting' : `${pending} new orders are waiting`}. Answer
          before the countdown runs out.
        </p>
      ) : null}

      {GROUPS.map((group) => {
        const orders = buckets[group.key] ?? [];
        return (
          <section key={group.key} className="mb-6">
            <h2 className="mb-2 flex items-center gap-2 text-xs font-semibold tracking-wide uppercase">
              <span className={`size-2 rounded-full ${group.dot}`} aria-hidden />
              {group.title}
              <span className="text-muted font-normal">({orders.length})</span>
            </h2>
            {orders.length ? (
              <ul className="space-y-2">
                {orders.map((order) => (
                  <li key={order.order_id}>
                    <OrderCard order={order} vendorId={vendor.id} tone={group.tone} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted rounded-card border-line border border-dashed px-4 py-4 text-sm">
                Nothing here.
              </p>
            )}
          </section>
        );
      })}
    </main>
  );
}

function OrderCard({ order, vendorId, tone }) {
  return (
    <Link
      href={`/vendor/${vendorId}/orders/${order.order_id}`}
      className={`block rounded-lg border px-4 py-3 ${tone}`}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-mono text-base font-semibold">{order.order_number}</span>
        <span className="tabular-nums">{formatPesewas(order.total_pesewas)}</span>
      </div>
      <div className="text-muted mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span>
          {order.item_count} item{order.item_count === 1 ? '' : 's'}
        </span>
        <span>
          {order.fulfilment_type === 'PICKUP'
            ? 'Pickup'
            : `Delivery · ${order.destination_zone ?? 'campus'}`}
        </span>
        <PaymentTag order={order} />
        {order.bucket === 'NEW' ? (
          <Countdown key={order.seconds_to_deadline} seconds={order.seconds_to_deadline} />
        ) : (
          <Age key={order.age_seconds} seconds={order.age_seconds} />
        )}
      </div>
      {order.bucket === 'READY' && order.fulfilment_type === 'DELIVERY' ? (
        <p className="text-brand-700 mt-1 text-sm font-medium">
          {order.partner_assigned ? 'Partner assigned, coming to collect' : 'Finding a Partner…'}
        </p>
      ) : null}
    </Link>
  );
}

function PaymentTag({ order }) {
  const label = {
    UNPAID: 'Not paid',
    PENDING: 'Payment processing',
    PAID: 'Paid',
    FAILED: 'Payment failed',
    REFUND_PENDING: 'Refund pending',
    REFUNDED: 'Refunded',
  }[order.payment_status];

  const tone =
    order.payment_status === 'PAID'
      ? 'text-brand-700'
      : order.payment_status === 'FAILED'
        ? 'text-bad'
        : 'text-muted';

  return <span className={`font-medium ${tone}`}>{label}</span>;
}

/**
 * Ticking values.
 *
 * Both anchor on the number the SERVER computed and count from there, rather
 * than reading the clock during render. That keeps render pure and means a
 * phone with a wrong clock still shows the right countdown. The parent re-keys
 * these on every board refresh so they re-anchor to fresh server values.
 */
function useCountFrom(initial, step) {
  const [value, setValue] = useState(initial ?? 0);
  useEffect(() => {
    const timer = setInterval(() => setValue((current) => current + step), 1000);
    return () => clearInterval(timer);
  }, [step]);
  return value;
}

/** The 60-second answer window. */
function Countdown({ seconds }) {
  const left = useCountFrom(seconds, -1);
  if (seconds == null) return null;
  if (left <= 0) return <span className="text-bad font-semibold">expiring…</span>;
  return (
    <span className={`font-semibold tabular-nums ${left <= 15 ? 'text-bad' : 'text-warn'}`}>
      {left}s to answer
    </span>
  );
}

function Age({ seconds }) {
  const elapsed = useCountFrom(seconds, 1);
  if (seconds == null) return null;
  const minutes = Math.floor(elapsed / 60);
  return <span className="tabular-nums">{minutes < 1 ? 'just now' : `${minutes} min ago`}</span>;
}

/**
 * In-app new-order alert.
 *
 * Polls a cheap count rather than opening any push infrastructure. When the
 * number goes UP the page refreshes and a short tone plays, because a phone on
 * a counter is not being watched.
 */
function useNewOrderAlert({ vendorId, pending, initialPending, pollMs, onChange }) {
  const previous = useRef(initialPending ?? pending);

  useEffect(() => {
    document.title = pending > 0 ? `(${pending}) New orders · Campus Dash` : 'Vendor · Campus Dash';
  }, [pending]);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const response = await fetch(`/api/vendor/${vendorId}/pending`, { cache: 'no-store' });
        if (!response.ok) return;
        const { pending: latest } = await response.json();
        if (cancelled) return;

        if (latest > previous.current) {
          beep();
          onChange();
        }
        previous.current = latest;
      } catch {
        // Offline or a flaky counter connection: try again on the next tick.
      }
    }

    const timer = setInterval(poll, pollMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [vendorId, pollMs, onChange]);
}

/** Two short tones via Web Audio — no asset to load, no permission to ask for. */
function beep() {
  try {
    const AudioCtx = window.AudioContext ?? window.webkitAudioContext;
    if (!AudioCtx) return;
    const context = new AudioCtx();
    [0, 0.18].forEach((offset) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, context.currentTime + offset);
      gain.gain.exponentialRampToValueAtTime(0.2, context.currentTime + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + offset + 0.14);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(context.currentTime + offset);
      oscillator.stop(context.currentTime + offset + 0.16);
    });
  } catch {
    // Audio is a courtesy; the banner and the title badge do the real work.
  }
}
