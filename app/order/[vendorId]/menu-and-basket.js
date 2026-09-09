'use client';

import { useActionState, useEffect, useState, useTransition } from 'react';
import { quoteAction, submitOrderAction } from '../actions';
import { Card, Money, ErrorNote, EmptyState, Skeleton, ArrowLeftIcon, BagIcon } from '../../ui';

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
 *
 * PICKUP OR DELIVERY IS NOT ASKED HERE any more. It is asked after the vendor
 * has accepted, on the order screen, because until then there may be no order
 * to make the decision about — and it is the decision that costs GH₵5.
 */
export default function MenuAndBasket({ vendor, menu, gate = null }) {
  const [quantities, setQuantities] = useState({});
  const [step, setStep] = useState('menu');
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

  // Re-price whenever the basket changes.
  useEffect(() => {
    if (step !== 'review' || items.length === 0) return;

    let cancelled = false;
    startQuoting(async () => {
      const result = await quoteAction({ vendorId: vendor.vendor_id, items });
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
  }, [step, JSON.stringify(items), vendor.vendor_id]);

  const setQuantity = (id, next) =>
    setQuantities((current) => ({ ...current, [id]: Math.max(0, Math.min(50, next)) }));

  if (step === 'review' && !gate) {
    return (
      <Review
        vendor={vendor}
        menu={menu}
        items={items}
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
              <span className="bg-brand-700 grid size-6 shrink-0 place-items-center rounded-full text-xs text-white tabular-nums">
                {itemCount}
              </span>
              <span className="hidden sm:inline">
                {itemCount === 1 ? 'item' : 'items'} in basket
              </span>
            </span>
            {gate ? (
              <a
                href={gate.href}
                className="press bg-brand-700 hover:bg-brand-800 ml-auto rounded-full px-5 py-3 text-sm font-semibold text-white transition-colors"
              >
                {gate.label}
              </a>
            ) : (
              <button
                type="button"
                disabled={!canOrder}
                onClick={() => setStep('review')}
                className="press bg-brand-700 hover:bg-brand-800 ml-auto rounded-full px-6 py-3 text-sm font-semibold text-white transition-colors disabled:opacity-55"
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
        className="press bg-brand-700 hover:bg-brand-800 grid size-10 place-items-center rounded-full text-lg font-semibold text-white transition-colors"
      >
        +
      </button>
    </div>
  );
}

function Review({
  vendor,
  menu,
  items,
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
      <input type="hidden" name="vendor_id" value={vendor.vendor_id} />
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

      {/* No fulfilment question here. It is asked after the vendor accepts,
          on the order screen — see customer_choose_fulfilment(). Asking now
          would be asking somebody to decide whether to pay GH₵5 for delivery
          before knowing whether the kitchen is even going to cook. */}

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
          You are not charged yet. Once {vendor.name} accepts, you choose whether to collect it or
          have a Partner bring it. The delivery fee is added then, if you want one.
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
          className="press bg-brand-700 hover:bg-brand-800 flex-1 rounded-full py-3.5 text-base font-semibold text-white transition-colors disabled:opacity-55"
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
