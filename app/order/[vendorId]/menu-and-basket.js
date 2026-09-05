'use client';

import { useActionState, useEffect, useState, useTransition } from 'react';
import { quoteAction, submitOrderAction } from '../actions';
import {
  Card,
  Money,
  ErrorNote,
  EmptyState,
  Skeleton,
  ArrowLeftIcon,
  BagIcon,
  CheckIcon,
} from '../../ui';

/**
 * Menu, basket and checkout.
 *
 * The basket holds ids and quantities. It never holds a total: every figure
 * shown comes back from the server, priced by the same function that will
 * charge the customer. Nothing about that changed in the redesign — the quote
 * round-trip, the hidden inputs and the submit path are the originals.
 *
 * WHAT DID CHANGE is the shape of the two steps. Choosing is a browsing task
 * and gets the full width; reviewing is a committing task and narrows to a
 * single column, which is the composition the references use as an order gets
 * closer to being paid for.
 */
export default function MenuAndBasket({ vendor, menu, locations, gate = null }) {
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
  // `gate` is set when the viewer lacks the CUSTOMER capability — signed out,
  // or signed in without student onboarding. They can still browse and build a
  // basket; the checkout step becomes a link to whatever they are missing.
  const canOrder = vendor.is_accepting_orders && itemCount > 0 && !gate;

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

  if (step === 'review' && !gate) {
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

  if (menu.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<BagIcon className="size-6" />}
          title="Nothing on the menu yet"
          description={`${vendor.name} has not added any items. Try another vendor for now.`}
        />
      </Card>
    );
  }

  return (
    <>
      <h2 className="mb-3 text-base font-semibold tracking-tight sm:mb-4 sm:text-lg">Menu</h2>

      {/* Two columns from `md` up. A single long column of short rows wastes
          most of a laptop screen and makes the menu feel thinner than it is. */}
      <ul className="grid gap-3 md:grid-cols-2">
        {menu.map((item) => {
          const chosen = quantities[item.id] ?? 0;
          return (
            <li key={item.id}>
              <Card
                className={`h-full p-3.5 transition-colors sm:p-5 ${
                  item.is_available ? '' : 'bg-surface-2/60'
                } ${chosen > 0 ? 'border-brand-600 ring-brand-600/25 ring-1' : ''}`}
              >
                <div className="flex items-baseline justify-between gap-4">
                  <h3
                    className={`font-semibold break-words ${item.is_available ? '' : 'text-muted'}`}
                  >
                    {item.name}
                  </h3>
                  <span
                    className={`shrink-0 font-semibold ${item.is_available ? '' : 'text-muted'}`}
                  >
                    <Money pesewas={item.price_pesewas} />
                  </span>
                </div>

                {item.description ? (
                  <p className="text-muted mt-1.5 text-sm leading-relaxed">{item.description}</p>
                ) : null}

                {item.is_available ? (
                  <Stepper
                    value={chosen}
                    onChange={(next) => setQuantity(item.id, next)}
                    label={item.name}
                  />
                ) : (
                  <p className="text-muted mt-3 text-sm font-medium">Unavailable today</p>
                )}
              </Card>
            </li>
          );
        })}
      </ul>

      {/* The sticky basket bar. Sits above the mobile navigation, and only
          exists once something is in the basket — an always-present empty bar
          is a permanent reminder that you have not done anything. */}
      {itemCount > 0 ? (
        <div className="animate-sheet fixed inset-x-0 bottom-0 z-50 px-3 pb-3 sm:px-6 sm:pb-6">
          <div className="bg-surface border-line shadow-float mx-auto flex max-w-2xl items-center gap-3 rounded-full border p-2 pl-5">
            <span className="flex items-center gap-2 text-sm font-semibold">
              <span className="bg-brand-500 text-ink grid size-6 shrink-0 place-items-center rounded-full text-xs tabular-nums">
                {itemCount}
              </span>
              <span className="hidden sm:inline">
                {itemCount === 1 ? 'item' : 'items'} in basket
              </span>
            </span>
            {gate ? (
              <a
                href={gate.href}
                className="press bg-brand-500 text-ink hover:bg-brand-600 ml-auto rounded-full px-5 py-3 text-sm font-semibold transition-colors"
              >
                {gate.label}
              </a>
            ) : (
              <button
                type="button"
                disabled={!canOrder}
                onClick={() => setStep('review')}
                className="press bg-brand-500 text-ink hover:bg-brand-600 ml-auto rounded-full px-6 py-3 text-sm font-semibold transition-colors disabled:opacity-55"
              >
                Review order
              </button>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}

/**
 * Quantity control.
 *
 * Before anything is chosen it is a single "Add" pill — a −/0/+ stepper sitting
 * at zero on every row is a lot of controls saying nothing. Once there is a
 * quantity it becomes the stepper. Both are 44px targets.
 */
function Stepper({ value, onChange, label }) {
  if (value === 0) {
    return (
      <button
        type="button"
        onClick={() => onChange(1)}
        className="press border-line-strong hover:border-brand-600 hover:bg-brand-50 mt-3 inline-flex h-10 items-center gap-1.5 rounded-full border px-4 text-sm font-semibold transition-colors"
      >
        Add
        <span aria-hidden className="text-base leading-none">
          +
        </span>
        <span className="sr-only">{label}</span>
      </button>
    );
  }

  return (
    <div className="mt-3 flex items-center gap-1">
      <button
        type="button"
        aria-label={`Remove one ${label}`}
        onClick={() => onChange(value - 1)}
        className="press bg-surface-2 hover:bg-surface-3 grid size-10 place-items-center rounded-full text-lg font-semibold transition-colors"
      >
        −
      </button>
      <span className="w-9 text-center font-semibold tabular-nums" aria-live="polite">
        {value}
      </span>
      <button
        type="button"
        aria-label={`Add one ${label}`}
        onClick={() => onChange(value + 1)}
        className="press bg-brand-500 text-ink hover:bg-brand-600 grid size-10 place-items-center rounded-full text-lg font-semibold transition-colors"
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
    price: menu.find((m) => m.id === item.menuItemId)?.price_pesewas ?? 0,
  }));

  return (
    <form action={submit} className="mx-auto max-w-xl">
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

      <button
        type="button"
        onClick={onBack}
        className="text-muted hover:text-ink press-sm mb-5 -ml-1 inline-flex items-center gap-1.5 rounded-full py-1 pr-3 pl-1 text-sm font-medium transition-colors"
      >
        <ArrowLeftIcon className="size-4" />
        Back to menu
      </button>

      <h2 className="text-display text-2xl font-semibold sm:text-3xl">Review your order</h2>
      <p className="text-muted mt-1.5">From {vendor.name}</p>

      {/* --- Items ------------------------------------------------------- */}
      <Card className="mt-7 p-5">
        <h3 className="text-muted mb-3 text-xs font-semibold tracking-[0.14em] uppercase">
          Your order
        </h3>
        <ul className="divide-line divide-y">
          {named.map((item) => (
            <li key={item.menuItemId} className="flex items-baseline justify-between gap-4 py-2.5">
              <span className="min-w-0">
                <span className="bg-surface-2 mr-2 inline-block rounded px-1.5 py-0.5 text-xs font-semibold tabular-nums">
                  {item.quantity}×
                </span>
                {item.name}
              </span>
              <span className="text-muted shrink-0 text-sm">
                <Money pesewas={item.price * item.quantity} />
              </span>
            </li>
          ))}
        </ul>
      </Card>

      {/* --- Fulfilment --------------------------------------------------- */}
      <Card className="mt-4 p-5">
        <h3 className="text-muted mb-3 text-xs font-semibold tracking-[0.14em] uppercase">
          How do you want it?
        </h3>

        {/* Real radios, so this is keyboard- and screen-reader-native. A row of
            buttons would have needed roving tabindex and still told a screen
            reader nothing about what was selected. */}
        <div role="radiogroup" aria-label="Fulfilment" className="flex gap-2">
          {[
            ['DELIVERY', 'Bring it to me'],
            ['PICKUP', 'I will collect'],
          ].map(([value, label]) => (
            <label key={value} className="press flex-1 cursor-pointer">
              <input
                type="radio"
                name="fulfilment_choice"
                value={value}
                checked={fulfilment === value}
                onChange={() => setFulfilment(value)}
                className="peer sr-only"
              />
              <span className="border-line-strong peer-checked:bg-brand-500 peer-checked:border-brand-500 peer-focus-visible:outline-brand-600 flex items-center justify-center gap-2 rounded-full border px-4 py-3 text-center text-sm font-semibold transition-colors peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2">
                {fulfilment === value ? <CheckIcon className="size-4" /> : null}
                {label}
              </span>
            </label>
          ))}
        </div>

        {fulfilment === 'DELIVERY' ? (
          <div className="mt-5 space-y-4">
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium">Where on campus?</span>
              <select
                value={destination}
                onChange={(event) => setDestination(event.target.value)}
                className="rounded-input bg-surface border-line-strong text-ink focus:border-brand-600 h-12 w-full border px-4 text-[15px] outline-none"
              >
                {locations.map((location) => (
                  <option key={location.location_id} value={location.location_id}>
                    {location.path}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium">Anything else? (optional)</span>
              <input
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Call when you reach the gate"
                className="rounded-input bg-surface border-line-strong text-ink placeholder:text-faint focus:border-brand-600 h-12 w-full border px-4 text-[15px] outline-none"
              />
            </label>
          </div>
        ) : (
          <p className="text-muted mt-4 text-sm leading-relaxed">
            You will collect this from {vendor.name} once they mark it ready. No delivery fee.
          </p>
        )}
      </Card>

      {/* --- Money -------------------------------------------------------- */}
      <Card className="mt-4 p-5">
        <h3 className="text-muted mb-3 text-xs font-semibold tracking-[0.14em] uppercase">
          What you pay
        </h3>

        {quoteError ? (
          <ErrorNote>{quoteError}</ErrorNote>
        ) : quote ? (
          <dl className={`transition-opacity ${quoting ? 'opacity-45' : ''}`}>
            <Line label="Food" value={quote.subtotal_pesewas} />
            <Line label="Service fee" value={quote.service_fee_pesewas} />
            {quote.delivery_fee_pesewas > 0 ? (
              <Line label="Delivery fee" value={quote.delivery_fee_pesewas} />
            ) : null}
            <div className="border-line mt-2 flex items-baseline justify-between gap-4 border-t pt-3">
              <dt className="font-semibold">Total</dt>
              <dd className="text-lg font-semibold">
                <Money pesewas={quote.total_pesewas} />
              </dd>
            </div>
          </dl>
        ) : (
          <div className="space-y-2.5" aria-live="polite" aria-busy="true">
            <span className="sr-only">Working out your total</span>
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-6 w-1/2" />
          </div>
        )}

        <p className="text-muted mt-4 text-xs leading-relaxed">
          You will not be charged until {vendor.name} accepts your order.
        </p>
      </Card>

      {submitState.message ? <ErrorNote className="mt-4">{submitState.message}</ErrorNote> : null}

      <div className="mt-6 flex gap-3">
        <button
          type="button"
          onClick={onBack}
          className="press border-line-strong hover:bg-surface-2 rounded-full border px-5 py-3.5 text-sm font-semibold transition-colors"
        >
          Back
        </button>
        <button
          type="submit"
          disabled={submitting || !quote || quoting}
          className="press bg-brand-500 text-ink hover:bg-brand-600 flex-1 rounded-full py-3.5 text-base font-semibold transition-colors disabled:opacity-55"
        >
          {submitting ? 'Sending…' : 'Send order to vendor'}
        </button>
      </div>
    </form>
  );
}

function Line({ label, value }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <dt className="text-muted text-sm">{label}</dt>
      <dd className="text-sm">
        <Money pesewas={value} />
      </dd>
    </div>
  );
}
