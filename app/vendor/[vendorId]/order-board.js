'use client';

import { useActionState, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { setAcceptingOrdersAction } from '../actions';
import { formatPesewas } from '@/lib/util/money';
import { orderLabel } from '@/lib/orders/state';
import { Button, Stat, Unavailable, ChevronRightIcon, SuccessNote, ErrorNote } from '@/app/ui';

/**
 * The store's day on one screen.
 *
 * Designed for a phone propped next to a hot plate, and read top to bottom in
 * the order the questions come:
 *
 *   1. Am I open?                    the status line and its one button
 *   2. How is today going?           Today's orders, Today's sales
 *   3. What needs me right now?      to prepare, then ready for collection
 *   4. What just happened?           the last few finished, then History
 *
 * EVERY FIGURE IS THE STORE'S OWN. The sales number and the amount on each card
 * are the food subtotal: what this store is paid. The customer's total and the
 * fees are not on this screen because vendor_order_board() no longer returns
 * them.
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
    title: 'Ready for collection',
    tone: 'border-brand-600 bg-surface',
    dot: 'bg-good',
    empty: 'Nothing waiting at the counter.',
  },
];

export default function OrderBoard({ vendor, buckets, initialPending, pollMs = 8000, today }) {
  const router = useRouter();
  const [openState, toggleOpen, toggling] = useActionState(setAcceptingOrdersAction, {});
  const pending = buckets.NEW.length;
  const finished = buckets.CLOSED ?? [];
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

  const open = vendor.is_accepting_orders;
  const nothingActive = buckets.NEW.length === 0 && buckets.READY.length === 0;

  return (
    <main className="mx-auto max-w-3xl px-4 pt-5 pb-16 sm:px-6 sm:pt-8">
      <CollectedToast count={collected} onDone={() => setCollected(0)} />

      {/* 1. WHERE AM I, AND AM I OPEN. */}
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-display text-2xl font-semibold break-words sm:text-3xl">
            {vendor.name}
          </h1>
          <p className="mt-1.5 flex items-center gap-2 text-sm">
            <span
              className={`size-2 rounded-full ${open ? 'bg-good' : 'bg-line-strong'}`}
              aria-hidden
            />
            <span className={open ? 'text-good font-semibold' : 'text-muted font-semibold'}>
              {open ? 'Open for orders' : 'Closed to new orders'}
            </span>
          </p>
        </div>

        <form action={toggleOpen} className="shrink-0">
          <input type="hidden" name="vendor_id" value={vendor.vendor_id} />
          <input type="hidden" name="accepting" value={open ? 'false' : 'true'} />
          {/* OPENING is the primary action when closed; closing is a quiet one,
              because it is the button nobody should hit by accident. */}
          <Button type="submit" variant={open ? 'secondary' : 'primary'} pending={toggling}>
            {toggling ? (open ? 'Closing…' : 'Opening…') : open ? 'Close store' : 'Open store'}
          </Button>
        </form>
      </header>

      {openState.message ? (
        openState.ok ? (
          <SuccessNote className="mt-3">{openState.message}</SuccessNote>
        ) : (
          <ErrorNote className="mt-3">{openState.message}</ErrorNote>
        )
      ) : null}

      {/* 2. HOW IS TODAY GOING. Two numbers, both the store's own. */}
      {today ? (
        <dl className="mt-6 grid grid-cols-2 gap-3">
          <Stat label="Today's orders" value={today.orders} />
          <Stat label="Today's sales" value={formatPesewas(today.salesPesewas)} />
        </dl>
      ) : (
        <Unavailable className="mt-6">
          Today&apos;s totals could not be loaded. Your orders below are still up to date.
        </Unavailable>
      )}

      {/* 3. WHAT NEEDS ME. */}
      <div className="mt-8 space-y-7">
        {nothingActive ? (
          <p className="text-muted bg-surface-2 rounded-card px-4 py-5 text-sm leading-relaxed">
            {open
              ? 'No orders in progress. New paid orders appear here with a sound.'
              : 'Your store is closed, so no new orders will arrive. Open it when you are ready to cook.'}
          </p>
        ) : (
          GROUPS.map((group) => {
            const orders = buckets[group.key] ?? [];
            if (group.key === 'READY' && orders.length === 0) return null;
            return (
              <section key={group.key}>
                <h2 className="mb-3 flex items-center gap-2 font-semibold">
                  <span className={`size-2 rounded-full ${group.dot}`} aria-hidden />
                  {group.title}
                  <span className="text-muted font-normal tabular-nums">{orders.length}</span>
                </h2>
                {orders.length ? (
                  <ul className="space-y-2.5">
                    {orders.map((order) => (
                      <li key={order.order_id}>
                        <OrderCard order={order} vendorId={vendor.vendor_id} tone={group.tone} />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-muted bg-surface-2 rounded-card px-4 py-4 text-sm">
                    {group.empty}
                  </p>
                )}
              </section>
            );
          })
        )}

        {/* 4. WHAT JUST HAPPENED. A few, then the record. */}
        <section>
          <div className="mb-3 flex items-baseline justify-between gap-4">
            <h2 className="font-semibold">Recently finished</h2>
            <Link
              href="/vendor/history"
              className="text-brand-700 press-sm -mr-2 inline-flex min-h-11 items-center gap-0.5 rounded-full px-2 text-sm font-semibold"
            >
              Order history
              <ChevronRightIcon className="size-4" />
            </Link>
          </div>
          {finished.length ? (
            <ul className="bg-surface border-line divide-line rounded-card divide-y border">
              {finished.map((order) => (
                <li key={order.order_id}>
                  <FinishedRow order={order} vendorId={vendor.vendor_id} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted text-sm">Nothing finished yet.</p>
          )}
        </section>
      </div>
    </main>
  );
}

/**
 * One order on the board.
 *
 * WHO IS COLLECTING IS DELIBERATELY NOT ON THIS CARD. A counter does the same
 * work either way — make it, check the scan if there is one, read out four
 * digits to whoever is standing there — and naming the recipient invited stores
 * to treat the two differently. What IS shown is the handoff state, because
 * somebody waiting at the counter is the only thing that needs an answer this
 * second.
 */
function OrderCard({ order, vendorId, tone }) {
  const scan = order.order_type === 'SCAN';
  const needsScanCheck = scan && ['UPLOADED', 'RELEASED'].includes(order.scan_status);

  const callout = needsScanCheck
    ? { text: 'Check the meal scan before you hand anything over', strong: true }
    : order.awaiting_handoff
      ? { text: 'Someone is at the counter. Open to read out the code', strong: true }
      : order.vendor_completed_at
        ? { text: 'Handed over. Nothing more to do', strong: false }
        : order.bucket === 'READY'
          ? { text: 'Waiting to be collected', strong: false }
          : null;

  return (
    <Link
      href={`/vendor/${vendorId}/orders/${order.order_id}`}
      className={`press rounded-card hover:border-brand-600 flex items-center gap-4 border px-4 py-3.5 transition-colors ${tone}`}
    >
      {/* THE NUMBER THE COUNTER CALLS OUT. Three digits, restarting at 001
          every morning, unique to this store — not a database key. A meal scan
          takes one exactly like everything else, because the queue is the
          queue. */}
      <span className="w-16 shrink-0 text-3xl leading-none font-bold tabular-nums">
        {orderLabel(order)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline gap-x-2 text-sm">
          {scan ? (
            <span className="bg-brand-50 text-brand-800 rounded px-1.5 py-0.5 text-xs font-semibold">
              Meal scan
            </span>
          ) : null}
          <span className="text-muted">
            {order.item_count} item{order.item_count === 1 ? '' : 's'} ·{' '}
            <Age key={order.age_seconds} seconds={order.age_seconds} />
          </span>
        </span>
        {callout ? (
          <span
            className={`mt-1 block text-sm ${callout.strong ? 'text-brand-800 font-semibold' : 'text-muted'}`}
          >
            {callout.text}
          </span>
        ) : null}
      </span>
      <span className="shrink-0 text-right">
        {/* WHAT CAMPUS DASH PAYS THIS STORE. On a meal scan that is nothing —
            the university's system settles it — so the scan's value is shown
            instead, marked as what it is, rather than a bare GH₵0.00 that
            reads like a mistake. */}
        {scan ? (
          <span className="block text-sm font-semibold tabular-nums">
            {formatPesewas(order.scan_value_pesewas)}
            <span className="text-muted block text-xs font-normal">on scan</span>
          </span>
        ) : (
          <span className="block font-semibold tabular-nums">
            {formatPesewas(order.vendor_amount_pesewas)}
          </span>
        )}
        <ChevronRightIcon className="text-faint ml-auto size-5" />
      </span>
    </Link>
  );
}

function FinishedRow({ order, vendorId }) {
  const cancelled =
    ['CANCELLED', 'CANCELLED_BY_VENDOR', 'REJECTED', 'EXPIRED'].includes(order.order_status) ||
    order.payment_status !== 'PAID';
  return (
    <Link
      href={`/vendor/${vendorId}/orders/${order.order_id}`}
      className="press-sm hover:bg-surface-2 flex min-h-14 items-center gap-4 px-4 py-2.5 transition-colors"
    >
      <span className="w-12 shrink-0 font-semibold tabular-nums">{orderLabel(order)}</span>
      <span className={`min-w-0 flex-1 text-sm ${cancelled ? 'text-bad' : 'text-muted'}`}>
        {order.payment_status === 'REFUNDED'
          ? 'Refunded'
          : order.payment_status === 'REFUND_PENDING'
            ? 'Refund pending'
            : cancelled
              ? 'Cancelled'
              : order.scan_status === 'REFUSED'
                ? 'Scan refused'
                : 'Handed over'}
        {order.order_type === 'SCAN' ? <span className="text-faint"> · meal scan</span> : null}
      </span>
      <span
        className={`shrink-0 text-sm font-semibold tabular-nums ${cancelled ? 'text-faint line-through' : ''}`}
      >
        {formatPesewas(
          order.order_type === 'SCAN' ? order.scan_value_pesewas : order.vendor_amount_pesewas
        )}
      </span>
      <ChevronRightIcon className="text-faint size-4 shrink-0" />
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
