'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { setAcceptingOrdersAction } from '../actions';
import { formatPesewas } from '@/lib/util/money';
import { orderLabel } from '@/lib/orders/state';

/**
 * The store's whole day on one screen.
 *
 * Designed for a phone propped next to a hot plate: big numbers, large touch
 * targets, and the oldest unmade order at the top of the list that needs
 * attention.
 *
 * THREE GROUPS, because there are three things an order can be to a store now.
 * There used to be four, and the extra one existed only because a store had to
 * answer a doorbell before anybody paid. Every order on this board has been
 * paid for: make it, hand it over, done.
 */
const GROUPS = [
  {
    key: 'NEW',
    title: 'To prepare',
    tone: 'border-brand-600/40 bg-brand-50',
    dot: 'bg-brand-600',
    empty: 'Nothing to make right now.',
  },
  {
    key: 'READY',
    title: 'Ready — waiting to be collected',
    tone: 'border-brand-600 bg-brand-100',
    dot: 'bg-brand-700',
    empty: 'Nothing waiting at the counter.',
  },
  {
    key: 'CLOSED',
    title: 'Finished',
    tone: 'border-line bg-surface',
    dot: 'bg-surface-3',
    empty: 'Nothing finished yet today.',
  },
];

export default function OrderBoard({ vendor, buckets, initialPending, pollMs = 8000 }) {
  const router = useRouter();
  const [openState, toggleOpen, toggling] = useActionState(setAcceptingOrdersAction, {});
  const pending = buckets.NEW.length;

  useNewOrderAlert({
    vendorId: vendor.vendor_id,
    pending,
    initialPending,
    pollMs,
    onChange: () => router.refresh(),
  });

  return (
    <main className="mx-auto max-w-2xl px-4 pt-4 pb-16">
      <header className="mb-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight">{vendor.name}</h1>
            <p className="mt-0.5 flex items-center gap-1.5 text-sm">
              <span
                className={`size-1.5 rounded-full ${vendor.is_accepting_orders ? 'bg-good' : 'bg-surface-3'}`}
                aria-hidden
              />
              <span
                className={vendor.is_accepting_orders ? 'text-good font-semibold' : 'text-muted'}
              >
                {vendor.is_accepting_orders ? 'Open for orders' : 'Closed to new orders'}
              </span>
            </p>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
              <Link href="/vendor/menu" className="text-brand-700 font-medium">
                Menu &amp; sold out →
              </Link>
              <Link href="/vendor/profile" className="text-brand-700 font-medium">
                Store details →
              </Link>
            </div>
          </div>

          <form action={toggleOpen} className="shrink-0">
            <input type="hidden" name="vendor_id" value={vendor.vendor_id} />
            <input
              type="hidden"
              name="accepting"
              value={vendor.is_accepting_orders ? 'false' : 'true'}
            />
            <button
              type="submit"
              disabled={toggling}
              className={`press rounded-full px-4 py-2.5 text-sm font-semibold transition-colors disabled:opacity-60 ${
                vendor.is_accepting_orders
                  ? 'text-ink bg-surface ring-line-strong ring-1'
                  : 'bg-brand-700 text-white'
              }`}
            >
              {toggling
                ? vendor.is_accepting_orders
                  ? 'Closing…'
                  : 'Opening…'
                : vendor.is_accepting_orders
                  ? 'Close store'
                  : 'Open store'}
            </button>
          </form>
        </div>
        {openState.message ? (
          <p
            role="status"
            className={`mt-2.5 text-sm ${openState.ok ? 'text-brand-700' : 'text-bad'}`}
          >
            {openState.message}
          </p>
        ) : null}
      </header>

      {pending > 0 ? (
        <p
          role="status"
          className="bg-warn-bg text-warn mb-4 rounded-full px-4 py-3 text-sm font-semibold"
        >
          {pending === 1 ? '1 paid order to prepare' : `${pending} paid orders to prepare`}.
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
                    <OrderCard order={order} vendorId={vendor.vendor_id} tone={group.tone} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted rounded-card border-line border border-dashed px-4 py-4 text-sm">
                {group.empty}
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
      className={`press rounded-card block border px-4 py-3.5 transition-colors ${tone}`}
    >
      <div className="flex items-baseline justify-between gap-3">
        {/* THE NUMBER THE COUNTER CALLS OUT. Three digits, restarting at 001
            every morning, unique to this store — not a database key. */}
        <span className="text-2xl leading-none font-bold tabular-nums">{orderLabel(order)}</span>
        <span className="font-semibold tabular-nums">{formatPesewas(order.total_pesewas)}</span>
      </div>
      <div className="text-muted mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span>
          {order.item_count} item{order.item_count === 1 ? '' : 's'}
        </span>
        <span>
          {order.fulfilment_type === 'PICKUP'
            ? 'Customer collects'
            : `Partner delivery · ${order.destination_zone ?? 'campus'}`}
        </span>
        <Age key={order.age_seconds} seconds={order.age_seconds} />
      </div>
      {/* THE ONE LINE A BUSY COUNTER ACTUALLY NEEDS. Somebody standing there
          waiting for a code is the only thing that requires the store to act
          this second. */}
      {order.partner_waiting ? (
        <p className="text-brand-700 mt-1.5 text-sm font-semibold">
          Partner waiting — open to read out the code
        </p>
      ) : order.awaiting_collection ? (
        <p className="text-brand-700 mt-1.5 text-sm font-semibold">
          Customer collecting — open to read out the code
        </p>
      ) : order.bucket === 'READY' && order.fulfilment_type === 'DELIVERY' ? (
        <p className="text-muted mt-1.5 text-sm font-medium">Waiting for a Partner…</p>
      ) : null}
    </Link>
  );
}

/**
 * A ticking age.
 *
 * Anchors on the number the SERVER computed and counts from there, rather than
 * reading the clock during render. That keeps render pure and means a phone
 * with a wrong clock still shows the right elapsed time. The parent re-keys it
 * on every board refresh so it re-anchors to a fresh server value.
 */
function Age({ seconds }) {
  const [elapsed, setElapsed] = useState(seconds ?? 0);
  useEffect(() => {
    const timer = setInterval(() => setElapsed((current) => current + 1), 1000);
    return () => clearInterval(timer);
  }, []);
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
    document.title =
      pending > 0 ? `(${pending}) Orders to prepare · Campus Dash` : 'Vendor · Campus Dash';
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
