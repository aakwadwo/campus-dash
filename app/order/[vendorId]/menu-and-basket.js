'use client';

import { useActionState, useEffect, useState, useTransition } from 'react';
import { quoteAction, submitOrderAction } from '../actions';
import FulfilmentChoice from '../../fulfilment-choice';
import {
  Card,
  Money,
  ErrorNote,
  EmptyState,
  Skeleton,
  Spinner,
  ArrowLeftIcon,
  BagIcon,
} from '../../ui';

/**
 * Menu, basket and checkout.
 *
 * The basket holds ids and quantities. It never holds a total: every figure
 * shown comes back from the server, priced by the same arithmetic that will
 * charge the customer.
 *
 * PICKUP OR DELIVERY IS ASKED HERE, and that is the whole shape of the new
 * order flow. There is no vendor to wait on any more, so there is nothing to
 * decide it after — the customer chooses, sees the final price including the
 * GH₵5 if they want it, and pays. A store only ever sees an order that has
 * been paid for.
 *
 * Delivery can be switched off centrally. When it is, the option is visibly
 * unavailable rather than absent: "no Partners right now" is information, and
 * an option that silently vanishes reads as a bug.
 */
export default function MenuAndBasket({
  vendor,
  menu,
  locations = [],
  deliveryAvailable = true,
  deliveryFeePesewas = null,
  gate = null,
}) {
  const [quantities, setQuantities] = useBasket(vendor.vendor_id, menu);
  const [step, setStep] = useState('menu');
  const [fulfilment, setFulfilment] = useState('PICKUP');
  const [destination, setDestination] = useState('');
  const [note, setNote] = useState('');
  const [quote, setQuote] = useState(null);
  const [quoteError, setQuoteError] = useState(null);
  const [quoting, startQuoting] = useTransition();
  const [submitState, submit, submitting] = useActionState(submitOrderAction, {});

  // THE FEE FOR A PARTNER ORDER, remembered across re-quotes. Only a quote that
  // was actually priced for a Partner may set it, which is what stops a
  // collection quote's zero being shown against the Partner option — see
  // FulfilmentChoice for the full account of that bug.
  const [quotedPartnerFee, setQuotedPartnerFee] = useState(null);

  const items = Object.entries(quantities)
    .filter(([, quantity]) => quantity > 0)
    .map(([menuItemId, quantity]) => ({ menuItemId, quantity }));

  const itemCount = items.reduce((total, item) => total + item.quantity, 0);
  // `gate` is set when the viewer lacks the CUSTOMER capability — signed out,
  // or signed in without student onboarding. They can still browse and build a
  // basket; the checkout step becomes a link to whatever they are missing.
  const canOrder = vendor.is_accepting_orders && itemCount > 0 && !gate;

  // WHAT IS ACTUALLY BEING BOUGHT. Delivery can be switched off centrally, and
  // when it is the choice collapses to collection here rather than being
  // corrected after a round trip — the server refuses it too, but a screen that
  // quotes GH₵5 for something it is about to be told it cannot have is a screen
  // that lied.
  const fulfilmentChoice = deliveryAvailable ? fulfilment : 'PICKUP';

  // Re-price whenever the basket or the fulfilment changes. The delivery fee is
  // part of the answer, so changing the choice re-asks the server rather than
  // adding GH₵5 in the browser.
  useEffect(() => {
    if (step !== 'review' || items.length === 0) return;

    let cancelled = false;
    startQuoting(async () => {
      const result = await quoteAction({
        vendorId: vendor.vendor_id,
        items,
        fulfilmentType: fulfilmentChoice,
      });
      if (cancelled) return;
      if (result.ok) {
        setQuote(result.quote);
        setQuoteError(null);
        if (fulfilmentChoice === 'DELIVERY') {
          setQuotedPartnerFee(Number(result.quote.delivery_fee_pesewas ?? 0));
        }
      } else {
        setQuote(null);
        setQuoteError(result.message);
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, JSON.stringify(items), fulfilmentChoice, vendor.vendor_id]);

  /**
   * The provider's checkout is on another origin, so getting there is a full
   * browser navigation rather than a client-side route change. Done in an
   * effect so React has committed the pending state first — the button stays
   * disabled while the page is on its way out.
   */
  useEffect(() => {
    if (!submitState.ok) return;
    // The order exists now, so the basket that became it is spent. Coming back
    // to this store should not offer to buy the same lunch twice.
    try {
      window.sessionStorage.removeItem(`campus-dash:basket:${vendor.vendor_id}`);
    } catch {
      // Storage unavailable: nothing was saved to clear.
    }
    window.location.href = submitState.redirectUrl || submitState.orderHref;
  }, [submitState, vendor.vendor_id]);

  const setQuantity = (id, next) =>
    setQuantities((current) => ({ ...current, [id]: Math.max(0, Math.min(50, next)) }));

  if (step === 'review' && !gate) {
    return (
      <Checkout
        vendor={vendor}
        menu={menu}
        items={items}
        locations={locations}
        deliveryAvailable={deliveryAvailable}
        deliveryFeePesewas={deliveryFeePesewas}
        quotedPartnerFee={quotedPartnerFee}
        fulfilment={fulfilmentChoice}
        onFulfilment={setFulfilment}
        destination={destination}
        onDestination={setDestination}
        note={note}
        onNote={setNote}
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
                className={`flex h-full gap-3.5 p-3.5 transition-colors sm:p-5 ${
                  item.is_available ? '' : 'bg-surface-2/60'
                } ${chosen > 0 ? 'border-brand-600 ring-brand-600/25 ring-1' : ''}`}
              >
                {/* THE DISH, WHEN THERE IS A PHOTOGRAPH OF IT. Lazy and
                    explicitly sized, so a menu of twenty items does not cost
                    twenty blocking requests on a campus connection, and the
                    layout does not jump as each one lands. A store that has not
                    added photographs gets a text menu rather than twenty grey
                    boxes — the absence is not worth reserving space for. */}
                {item.image_url ? (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    src={item.image_url}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    width={80}
                    height={80}
                    className={`rounded-card size-20 shrink-0 object-cover ${
                      item.is_available ? '' : 'opacity-50 saturate-50'
                    }`}
                  />
                ) : null}

                <div className="min-w-0 flex-1">
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
                    /* SOLD OUT, SHOWN. A dish that vanishes when it runs out
                     reads as a store that has stopped selling it; a dish marked
                     sold out reads as a store that is busy. */
                    <p className="text-muted mt-3 inline-flex items-center gap-1.5 text-sm font-semibold">
                      <span className="bg-surface-3 size-1.5 rounded-full" aria-hidden />
                      Sold out
                    </p>
                  )}
                </div>
              </Card>
            </li>
          );
        })}
      </ul>

      {/* The sticky basket bar. Sits above the mobile navigation, and only
          exists once something is in the basket — an always-present empty bar
          is a permanent reminder that you have not done anything. */}
      {itemCount > 0 ? (
        // ABOVE THE BOTTOM NAVIGATION, never on top of it. A signed-in customer
        // (no `gate`) has the mobile bottom bar from SiteHeader: 56px of targets,
        // a 1px rule and the safe area. Sitting over it made Browse, My orders
        // and Account untappable while anything was in the basket. Signed out
        // there is no bottom bar, so the basket keeps the bottom edge.
        <div
          className={`animate-sheet fixed inset-x-0 z-50 px-3 pb-3 sm:bottom-0 sm:px-6 sm:pb-6 ${
            gate ? 'bottom-0' : 'bottom-[calc(57px+env(safe-area-inset-bottom))]'
          }`}
        >
          <div className="bg-surface border-line shadow-float mx-auto flex max-w-2xl items-center gap-3 rounded-full border p-2 pl-5">
            <span className="flex items-center gap-2 text-sm font-semibold">
              <span className="bg-brand-700 grid size-6 shrink-0 place-items-center rounded-full text-xs text-white tabular-nums">
                {itemCount}
              </span>
              <span>{itemCount === 1 ? 'item' : 'items'}</span>
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
                Go to checkout
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

/**
 * One screen: what you ordered, how you want it, what it costs, pay.
 *
 * The Pay button is disabled while the quote is in flight, because the figure
 * beside it would be the figure for a choice the customer has just changed.
 */
function Checkout({
  vendor,
  menu,
  items,
  locations,
  deliveryAvailable,
  deliveryFeePesewas,
  quotedPartnerFee,
  fulfilment,
  onFulfilment,
  destination,
  onDestination,
  note,
  onNote,
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

  // The server's live answer wins over what the page was rendered with: the
  // switch can be flipped while somebody is filling in a basket.
  const canDeliver = quote ? quote.delivery_available !== false : deliveryAvailable;
  const needsDestination = fulfilment === 'DELIVERY' && !destination;
  // `leaving` keeps the button spent after the action resolves: the browser is
  // on its way to the payment page and a button that springs back to "Pay"
  // invites a second tap at the worst possible moment.
  const leaving = Boolean(submitState.ok);
  const busy = submitting || leaving;

  return (
    <form action={submit} className="mx-auto max-w-xl">
      <input type="hidden" name="vendor_id" value={vendor.vendor_id} />
      {/* Ids and quantities only. No prices leave the browser. */}
      <input
        type="hidden"
        name="items"
        value={JSON.stringify(items.map(({ menuItemId, quantity }) => ({ menuItemId, quantity })))}
      />
      <input type="hidden" name="fulfilment_type" value={fulfilment} />
      <input type="hidden" name="destination_location_id" value={destination} />
      <input type="hidden" name="destination_note" value={note} />

      <button
        type="button"
        onClick={onBack}
        disabled={busy}
        className="text-muted hover:text-ink hover:bg-surface-2 press-sm mb-4 -ml-2 inline-flex min-h-11 items-center gap-1.5 rounded-full pr-3.5 pl-2 text-sm font-medium transition-colors disabled:opacity-55"
      >
        <ArrowLeftIcon className="size-4" />
        Back to menu
      </button>

      <h2 className="text-display text-2xl font-semibold sm:text-3xl">Checkout</h2>
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

      {/* --- How you want it ---------------------------------------------- */}
      <Card className="mt-4 p-5">
        <h3 className="text-muted mb-3 text-xs font-semibold tracking-[0.14em] uppercase">
          How you want it
        </h3>

        <FulfilmentChoice
          value={fulfilment}
          onChange={onFulfilment}
          vendorName={vendor.name}
          partnerAvailable={canDeliver}
          feePesewas={deliveryFeePesewas}
          quotedFee={quotedPartnerFee}
        />

        {fulfilment === 'DELIVERY' && canDeliver ? (
          <div className="mt-4 space-y-3">
            <label className="block">
              <span className="text-sm font-medium">Where should the Partner bring it?</span>
              <select
                required
                value={destination}
                onChange={(event) => onDestination(event.target.value)}
                className="rounded-input bg-surface border-line-strong focus:border-brand-600 mt-1.5 h-12 w-full border px-3 text-base outline-none"
              >
                <option value="">Choose a place</option>
                {locations.map((place) => (
                  <option key={place.location_id ?? place.id} value={place.location_id ?? place.id}>
                    {place.path ?? place.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-sm font-medium">
                Anything that helps them find you{' '}
                <span className="text-muted font-normal">(optional)</span>
              </span>
              <input
                value={note}
                onChange={(event) => onNote(event.target.value)}
                maxLength={140}
                placeholder="Green door at the end of the corridor"
                className="rounded-input bg-surface border-line-strong focus:border-brand-600 placeholder:text-faint mt-1.5 h-12 w-full border px-3 text-base outline-none"
              />
            </label>
          </div>
        ) : null}
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
              <Line label="Campus Dash Partner" value={quote.delivery_fee_pesewas} />
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
          You pay once. {vendor.name} starts preparing as soon as the payment lands.
        </p>
      </Card>

      {submitState.message ? <ErrorNote className="mt-4">{submitState.message}</ErrorNote> : null}

      <div className="mt-6">
        <button
          type="submit"
          disabled={busy || !quote || quoting || needsDestination}
          aria-busy={busy || undefined}
          className="press bg-brand-700 hover:bg-brand-800 h-14 w-full rounded-full text-base font-semibold text-white transition-colors disabled:opacity-55"
        >
          {busy ? (
            <span className="inline-flex items-center justify-center gap-2">
              <Spinner className="size-4" />
              Taking you to pay…
            </span>
          ) : quote ? (
            <>
              Pay <Money pesewas={quote.total_pesewas} />
            </>
          ) : (
            'Pay'
          )}
        </button>
      </div>
      {needsDestination ? (
        <p className="text-muted mt-2.5 text-center text-xs">
          Choose where the Partner should bring it.
        </p>
      ) : null}
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

/**
 * The basket, kept for the length of the browser session.
 *
 * WHY. It used to live only in component state, so a refresh, a tap on the
 * header, or — worst — the trip to sign up and back emptied it, even though
 * the page promised the order would be waiting. It is kept per store in
 * sessionStorage: ids and quantities only, the same shape the server is sent,
 * and never a price. Items no longer on the menu are dropped on the way back
 * in, and anything unreadable is simply ignored.
 */
function useBasket(vendorId, menu) {
  const key = `campus-dash:basket:${vendorId}`;
  const [quantities, setQuantities] = useState({});
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    let saved = {};
    try {
      const raw = window.sessionStorage.getItem(key);
      const parsed = raw ? JSON.parse(raw) : {};
      const onMenu = new Set(menu.filter((m) => m.is_available).map((m) => m.id));
      saved = Object.fromEntries(
        Object.entries(parsed).filter(
          ([id, qty]) => onMenu.has(id) && Number.isInteger(qty) && qty > 0 && qty <= 50
        )
      );
    } catch {
      // Private mode or blocked storage: start empty, the basket still works.
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- restoring browser-only state after hydration
    setQuantities(saved);
    setRestored(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    if (!restored) return;
    try {
      const kept = Object.fromEntries(Object.entries(quantities).filter(([, q]) => q > 0));
      if (Object.keys(kept).length) window.sessionStorage.setItem(key, JSON.stringify(kept));
      else window.sessionStorage.removeItem(key);
    } catch {
      // Not being able to remember the basket is not worth interrupting anybody.
    }
  }, [key, quantities, restored]);

  return [quantities, setQuantities];
}
