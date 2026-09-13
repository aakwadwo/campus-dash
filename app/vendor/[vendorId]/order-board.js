'use client';

import { useActionState, useCallback, useEffect, useRef, useState } from 'react';
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
  // Shown when a handoff takes an order off the board, then cleared. Held here
  // rather than in the row, because by the time it fires the row is gone.
  const [collected, setCollected] = useState(0);

  const announceCompleted = useCallback((count) => setCollected(count), []);

  useNewOrderAlert({
    vendorId: vendor.vendor_id,
    pending,
    initialPending,
    pollMs,
    onChange: () => router.refresh(),
    onCompleted: announceCompleted,
  });

  return (
    <main className="mx-auto max-w-2xl px-4 pt-4 pb-16">
      <CollectedToast count={collected} onDone={() => setCollected(0)} />
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
function useNewOrderAlert({ vendorId, pending, initialPending, pollMs, onChange, onCompleted }) {
  const previous = useRef(initialPending ?? pending);
  // Starts unknown: the first poll establishes the baseline rather than
  // reporting a completion that happened before this screen was open.
  const previousActive = useRef(null);

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
        const { pending: latest, active } = await response.json();
        if (cancelled) return;

        // A NEW ORDER: chime, and pull the board.
        if (latest > previous.current) {
          beep();
          onChange();
        } else if (latest !== previous.current) {
          // IT WENT DOWN, which used to be ignored entirely — the old poll only
          // refreshed on an increase, so an order that left the board stayed on
          // screen until somebody reloaded. No chime: nothing needs doing.
          onChange();
        }
        previous.current = latest;

        // AN ORDER LEFT THE BOARD. Only `active` counts READY, so this is the
        // only signal that moves when a handoff completes an order.
        if (typeof active === 'number') {
          const before = previousActive.current;
          if (before !== null && active < before) {
            onCompleted(before - active);
            onChange();
          }
          previousActive.current = active;
        }
      } catch {
        // Offline or a flaky counter connection: try again on the next tick.
      }
    }

    const timer = setInterval(poll, pollMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [vendorId, pollMs, onChange, onCompleted]);
}

/**
 * "Collected" — the one flourish on this screen.
 *
 * It exists because a handoff is the only thing that happens to a vendor's
 * board WITHOUT them touching it: the customer types the code at the counter
 * and the row vanishes. Without a word, that reads as the app losing an order.
 *
 * Deliberately small. A tick that draws itself, a line of text, gone in two and
 * a half seconds — the shape of a payment confirmation rather than a
 * celebration. It does not block the board, cannot be clicked, and is announced
 * politely to a screen reader instead of stealing focus from whatever the
 * person was doing. Nothing else on this screen animates.
 */
function CollectedToast({ count, onDone }) {
  useEffect(() => {
    if (!count) return undefined;
    const timer = setTimeout(onDone, 2500);
    return () => clearTimeout(timer);
  }, [count, onDone]);

  if (!count) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none sticky top-2 z-30 mb-3 motion-safe:animate-[cd-fade-up_220ms_ease-out]"
    >
      <div className="border-good/30 bg-good/10 rounded-card flex items-center gap-3 border px-4 py-3 shadow-sm backdrop-blur">
        <span className="bg-good grid size-7 shrink-0 place-items-center rounded-full">
          <svg
            aria-hidden
            viewBox="0 0 24 24"
            fill="none"
            stroke="white"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="size-4"
          >
            {/* 32 is a little over the path length, so the dash draws the tick
                on rather than fading a finished one in. */}
            <path
              d="m20 6-11 11-5-5"
              className="motion-safe:animate-[cd-draw_320ms_ease-out_both]"
              style={{ strokeDasharray: 32 }}
            />
          </svg>
        </span>
        <p className="text-sm font-semibold">
          {count === 1 ? 'Order collected' : `${count} orders collected`}
        </p>
      </div>
    </div>
  );
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
