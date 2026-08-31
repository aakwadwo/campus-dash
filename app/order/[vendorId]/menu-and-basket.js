'use client';

import { useActionState, useEffect, useState, useTransition } from 'react';
import { quoteAction, submitOrderAction } from '../actions';
import { formatPesewas } from '@/lib/util/money';

/**
 * Menu, basket and checkout on one phone screen.
 *
 * The basket holds ids and quantities. It never holds a total: every figure
 * shown comes back from the server, priced by the same function that will
 * charge the customer.
 */
export default function MenuAndBasket({ vendor, menu, locations }) {
  const [quantities, setQuantities] = useState({});
  const [step, setStep] = useState('menu');
  const [fulfilment, setFulfilment] = useState('DELIVERY');
  const [destination, setDestination] = useState(locations[0]?.location_id ?? '');
  const [note, setNote] = useState('');
  const [quote, setQuote] = useState(null);
  const [quoteError, setQuoteError] = useState(null);
  const [quoting, startQuoting] = useTransition();
  const [submitState, submit, submitting] = useActionState(submitOrderAction, {});

  const items = Object.entries(quantities)
    .filter(([, quantity]) => quantity > 0)
    .map(([menuItemId, quantity]) => ({ menuItemId, quantity }));

  const itemCount = items.reduce((total, item) => total + item.quantity, 0);
  const canOrder = vendor.is_accepting_orders && itemCount > 0;

  // Re-price whenever anything that affects the total changes.
  useEffect(() => {
    if (step !== 'review' || items.length === 0) return;

    let cancelled = false;
    startQuoting(async () => {
      const result = await quoteAction({
        vendorId: vendor.id,
        fulfilmentType: fulfilment,
        items,
        destinationLocationId: fulfilment === 'DELIVERY' ? destination : null,
      });
      if (cancelled) return;
      if (result.ok) {
        setQuote(result.quote);
        setQuoteError(null);
      } else {
        setQuote(null);
        setQuoteError(result.message);
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, fulfilment, destination, JSON.stringify(items), vendor.id]);

  const setQuantity = (id, next) =>
    setQuantities((current) => ({ ...current, [id]: Math.max(0, Math.min(50, next)) }));

  if (step === 'review') {
    return (
      <Review
        vendor={vendor}
        menu={menu}
        quantities={quantities}
        items={items}
        fulfilment={fulfilment}
        setFulfilment={setFulfilment}
        locations={locations}
        destination={destination}
        setDestination={setDestination}
        note={note}
        setNote={setNote}
        quote={quote}
        quoting={quoting}
        quoteError={quoteError}
        onBack={() => setStep('menu')}
        submit={submit}
        submitting={submitting}
        submitState={submitState}
      />
    );
  }

  return (
    <>
      <ul className="mt-5 space-y-2">
        {menu.map((item) => (
          <li
            key={item.id}
            className={`rounded-lg px-4 py-3 ring-1 ring-black/5 ${
              item.is_available ? 'bg-white' : 'bg-black/[0.03]'
            }`}
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className={item.is_available ? 'font-medium' : 'text-muted font-medium'}>
                {item.name}
              </span>
              <span className="tabular-nums">{formatPesewas(item.price_pesewas)}</span>
            </div>
            {item.description ? (
              <p className="text-muted mt-0.5 text-sm">{item.description}</p>
            ) : null}

            {item.is_available ? (
              <Stepper
                value={quantities[item.id] ?? 0}
                onChange={(next) => setQuantity(item.id, next)}
                label={item.name}
              />
            ) : (
              <p className="text-muted mt-2 text-sm font-medium">Unavailable today</p>
            )}
          </li>
        ))}
      </ul>

      {itemCount > 0 ? (
        <div className="fixed inset-x-0 bottom-0 border-t border-black/10 bg-white px-4 py-3">
          <div className="mx-auto flex max-w-md items-center gap-3">
            <span className="text-sm">
              {itemCount} item{itemCount === 1 ? '' : 's'}
            </span>
            <button
              type="button"
              disabled={!canOrder}
              onClick={() => setStep('review')}
              className="bg-brand-600 ml-auto rounded-lg px-5 py-3 text-sm font-semibold text-white disabled:opacity-60"
            >
              Review order
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

function Stepper({ value, onChange, label }) {
  return (
    <div className="mt-2 flex items-center gap-3">
      <button
        type="button"
        aria-label={`Remove one ${label}`}
        onClick={() => onChange(value - 1)}
        disabled={value === 0}
        className="size-10 rounded-lg text-lg font-semibold ring-1 ring-black/15 disabled:opacity-40"
      >
        −
      </button>
      <span className="w-6 text-center tabular-nums" aria-live="polite">
        {value}
      </span>
      <button
        type="button"
        aria-label={`Add one ${label}`}
        onClick={() => onChange(value + 1)}
        className="size-10 rounded-lg text-lg font-semibold ring-1 ring-black/15"
      >
        +
      </button>
    </div>
  );
}

function Review({
  vendor,
  menu,
  quantities,
  items,
  fulfilment,
  setFulfilment,
  locations,
  destination,
  setDestination,
  note,
  setNote,
  quote,
  quoting,
  quoteError,
  onBack,
  submit,
  submitting,
  submitState,
}) {
  const named = items.map((item) => ({
    ...item,
    name: menu.find((m) => m.id === item.menuItemId)?.name ?? 'Item',
  }));

  return (
    <form action={submit} className="mt-5 space-y-5">
      <input type="hidden" name="vendor_id" value={vendor.id} />
      <input type="hidden" name="fulfilment_type" value={fulfilment} />
      <input
        type="hidden"
        name="destination_location_id"
        value={fulfilment === 'DELIVERY' ? destination : ''}
      />
      <input type="hidden" name="destination_note" value={note} />
      {/* Ids and quantities only. No prices leave the browser. */}
      <input
        type="hidden"
        name="items"
        value={JSON.stringify(items.map(({ menuItemId, quantity }) => ({ menuItemId, quantity })))}
      />

      <section className="rounded-lg bg-white p-4 ring-1 ring-black/5">
        <h2 className="mb-2 text-xs font-semibold tracking-wide uppercase">Your order</h2>
        <ul className="divide-y divide-black/5">
          {named.map((item) => (
            <li key={item.menuItemId} className="flex justify-between gap-3 py-2 text-sm">
              <span>
                <span className="font-semibold tabular-nums">{item.quantity}×</span> {item.name}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-lg bg-white p-4 ring-1 ring-black/5">
        <h2 className="mb-3 text-xs font-semibold tracking-wide uppercase">How do you want it?</h2>
        <div className="flex gap-2">
          {[
            ['DELIVERY', 'Bring it to me'],
            ['PICKUP', 'I will collect'],
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setFulfilment(value)}
              className={`flex-1 rounded-lg py-3 text-sm font-semibold ${
                fulfilment === value ? 'bg-brand-600 text-white' : 'ring-1 ring-black/15'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {fulfilment === 'DELIVERY' ? (
          <div className="mt-4 space-y-3">
            <label className="block">
              <span className="text-sm font-medium">Where on campus?</span>
              <select
                value={destination}
                onChange={(event) => setDestination(event.target.value)}
                className="mt-1 w-full rounded border border-black/15 bg-white px-3 py-2.5 text-sm"
              >
                {locations.map((location) => (
                  <option key={location.location_id} value={location.location_id}>
                    {location.path}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-sm font-medium">Anything else? (optional)</span>
              <input
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Call when you reach the gate"
                className="mt-1 w-full rounded border border-black/15 px-3 py-2.5 text-sm"
              />
            </label>
          </div>
        ) : (
          <p className="text-muted mt-3 text-sm">
            You will collect this from {vendor.name} once they mark it ready.
          </p>
        )}
      </section>

      <section className="rounded-lg bg-white p-4 ring-1 ring-black/5">
        <h2 className="mb-2 text-xs font-semibold tracking-wide uppercase">What you pay</h2>
        {quoteError ? (
          <p className="text-sm text-red-700">{quoteError}</p>
        ) : quote ? (
          <dl className={`space-y-1 text-sm ${quoting ? 'opacity-50' : ''}`}>
            <Line label="Food" value={quote.subtotal_pesewas} />
            <Line label="Service fee" value={quote.service_fee_pesewas} />
            {quote.delivery_fee_pesewas > 0 ? (
              <Line label="Delivery fee" value={quote.delivery_fee_pesewas} />
            ) : null}
            <div className="flex justify-between border-t border-black/5 pt-2 font-semibold">
              <dt>Total</dt>
              <dd className="tabular-nums">{formatPesewas(quote.total_pesewas)}</dd>
            </div>
          </dl>
        ) : (
          <p className="text-muted text-sm">Working out your total…</p>
        )}
        <p className="text-muted mt-3 text-xs">
          You will not be charged until {vendor.name} accepts your order.
        </p>
      </section>

      {submitState.message ? (
        <p role="alert" className="text-sm text-red-700">
          {submitState.message}
        </p>
      ) : null}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onBack}
          className="rounded-lg px-4 py-3 text-sm font-semibold ring-1 ring-black/15"
        >
          Back
        </button>
        <button
          type="submit"
          disabled={submitting || !quote || quoting}
          className="bg-brand-600 flex-1 rounded-lg py-3 text-base font-semibold text-white disabled:opacity-60"
        >
          {submitting ? 'Sending…' : 'Send order to vendor'}
        </button>
      </div>
    </form>
  );
}

function Line({ label, value }) {
  return (
    <div className="flex justify-between">
      <dt className="text-muted">{label}</dt>
      <dd className="tabular-nums">{formatPesewas(value)}</dd>
    </div>
  );
}
