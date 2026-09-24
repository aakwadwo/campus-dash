'use client';

import { useActionState, useEffect, useRef, useState, useTransition } from 'react';
import { quoteAction, submitOrderAction } from '../actions';
import FulfilmentChoice from '../../fulfilment-choice';
import ContactLine from '../../contact-line';
import CameraCapture from '../../camera-capture';
import DestinationPicker from '../../destination-picker';
import { Card, Money, ErrorNote, Skeleton, Spinner, ArrowLeftIcon, Callout } from '../../ui';
import { lineKey, parseLineKey, basketItems } from '@/lib/orders/basket';
import {
  PRICING_MODE,
  isVariablePrice,
  lowestPrice,
  checkChosenPrice,
  priceChoices,
  cedisText,
  priceSummary,
  parseCedis,
} from '@/lib/util/item-price';

/**
 * Menu, basket and checkout.
 *
 * The basket holds ids and quantities, and for an item whose price the
 * customer chooses, the amount they chose. It never holds a total: every figure
 * shown comes back from the server, priced by the same arithmetic that will
 * charge the customer — and that arithmetic refuses an amount that is not one
 * of the item's prices rather than rounding it to one.
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
// Matches order_notes_body_check and orders_destination_note_length. The
// database is the bound; this only stops somebody typing past it.
const NOTE_LIMIT = 280;

export default function MenuAndBasket({
  header = null,
  vendor,
  menu,
  label = 'Menu',
  locations = [],
  deliveryAvailable = true,
  deliveryFeePesewas = null,
  packFeePesewas = 0,
  gate = null,
}) {
  const [quantities, setQuantities] = useBasket(vendor.vendor_id, menu);
  // THE AMOUNT BEING CHOSEN on each variable item's card, as typed. Not the
  // basket: the basket holds a line per item AND price, and this only decides
  // which of those lines the card's quantity control is looking at.
  const [amounts, setAmounts] = useState({});
  const [step, setStep] = useState('menu');
  // NOTHING IS PRESELECTED. Collecting and a Partner are different decisions
  // with different prices, and a default is a decision made for somebody.
  const [fulfilment, setFulfilment] = useState(null);
  const [destination, setDestination] = useState(null);
  // TWO NOTES FOR TWO PEOPLE, never one field. Order information is about the
  // food and goes to the store; Additional information is for the Partner.
  const [orderNote, setOrderNote] = useState('');
  const [note, setNote] = useState('');
  const [quote, setQuote] = useState(null);
  const [quoteError, setQuoteError] = useState(null);
  const [quoting, startQuoting] = useTransition();
  const [submitState, submit, submitting] = useActionState(submitOrderAction, {});

  // REDEEM BY MEAL SCAN. Off by default, offered only where the store takes
  // one, and it changes which pricing function the quote comes from — so it is
  // a dependency of the re-quote below, exactly like the fulfilment choice.
  const [mealScan, setMealScan] = useState(false);
  const [scan, setScan] = useState(null);
  const [wantsPack, setWantsPack] = useState(false);
  const scanOffered = Boolean(vendor.can_accept_scans);
  // A store can be switched off mid-basket. The switch goes with it rather than
  // leaving somebody paying scan prices at a store that no longer takes one.
  const redeeming = scanOffered && mealScan;

  // THE FEE FOR A PARTNER ORDER, remembered across re-quotes. Only a quote that
  // was actually priced for a Partner may set it, which is what stops a
  // collection quote's zero being shown against the Partner option — see
  // FulfilmentChoice for the full account of that bug.
  const [quotedPartnerFee, setQuotedPartnerFee] = useState(null);

  // THE AMOUNT IS NOT THE QUANTITY. A variable item's chosen price picks the
  // basket line; the stepper sets how many of that line. Unreadable is NaN, so
  // it can never be mistaken for the last good amount.
  const chosenPrice = (item) =>
    amounts[item.id] === undefined
      ? lowestPrice(item)
      : (parseCedis(amounts[item.id]) ?? Number.NaN);
  const cardKey = (item) => lineKey(item.id, isVariablePrice(item) ? chosenPrice(item) : undefined);

  // ONE LINE PER THING BOUGHT: kelewele at GH₵10 and at GH₵20 are two lines of
  // one basket, and the same price added twice is one line with a quantity.
  const items = basketItems(quantities).filter((line) =>
    menu.some((m) => m.id === line.menuItemId)
  );

  const itemCount = items.reduce((total, item) => total + item.quantity, 0);
  // An amount the customer is still typing is not sent anywhere. Checkout waits
  // until every chosen amount is one of its item's prices.
  const pricesValid = items.every(
    (line) =>
      line.unitPricePesewas === undefined ||
      checkChosenPrice(
        menu.find((m) => m.id === line.menuItemId),
        line.unitPricePesewas
      ).ok
  );
  // `gate` is set when the viewer lacks the CUSTOMER capability — signed out,
  // or signed in without student onboarding. They can still browse and build a
  // basket; the checkout step becomes a link to whatever they are missing.
  const canOrder = vendor.is_accepting_orders && itemCount > 0 && pricesValid && !gate;

  // WHAT IS ACTUALLY BEING BOUGHT. Delivery can be switched off centrally, and
  // when it is the choice collapses to collection here rather than being
  // corrected after a round trip — the server refuses it too, but a screen that
  // quotes GH₵5 for something it is about to be told it cannot have is a screen
  // that lied.
  const fulfilmentChoice = !deliveryAvailable && fulfilment === 'DELIVERY' ? null : fulfilment;

  // WHAT THE BASKET IS, as one comparable value. Extracted rather than inlined
  // into the dependency array below, because an expression there cannot be
  // statically checked — and the array is long enough now that the blanket
  // disable it used to sit under was hiding more than the one line it was for.
  const basketKey = JSON.stringify(items);

  // Re-price whenever the basket, the fulfilment or the Meal Scan switch
  // changes. Every figure is part of the answer, so changing any of them
  // re-asks the server rather than adding anything up in the browser.
  useEffect(() => {
    if (step !== 'review' || items.length === 0) return;

    let cancelled = false;
    startQuoting(async () => {
      const result = await quoteAction({
        vendorId: vendor.vendor_id,
        items,
        fulfilmentType: fulfilmentChoice,
        mealScan: redeeming,
        wantsPack,
        destinationLocationId: fulfilmentChoice === 'DELIVERY' ? destination || null : null,
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
  }, [step, basketKey, fulfilmentChoice, vendor.vendor_id, redeeming, wantsPack, destination]);

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

  // ARRIVING FROM A SEARCH RESULT. The link carries #item-<id>; a client-side
  // navigation into a streamed page does not scroll to it or set :target, so
  // this does both, once, after the menu is on screen.
  const [found, setFound] = useState(null);
  useEffect(() => {
    const id = window.location.hash.startsWith('#item-') ? window.location.hash.slice(6) : null;
    if (!id) return undefined;
    const el = document.getElementById(`item-${id}`);
    if (!el) return undefined;
    el.scrollIntoView({ block: 'center' });
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reading the URL hash after hydration
    setFound(id);
    const timer = setTimeout(() => setFound(null), 2400);
    return () => clearTimeout(timer);
  }, []);

  const setQuantity = (key, next) =>
    setQuantities((current) => ({ ...current, [key]: Math.max(0, Math.min(50, next)) }));

  if (step === 'review' && !gate) {
    return (
      <CheckoutAtTop>
        <Checkout
          vendor={vendor}
          menu={menu}
          items={items}
          locations={locations}
          deliveryAvailable={deliveryAvailable}
          deliveryFeePesewas={deliveryFeePesewas}
          packFeePesewas={packFeePesewas}
          quotedPartnerFee={quotedPartnerFee}
          scanOffered={scanOffered}
          mealScan={redeeming}
          onMealScan={setMealScan}
          scan={scan}
          onScan={setScan}
          wantsPack={wantsPack}
          onWantsPack={setWantsPack}
          fulfilment={fulfilmentChoice}
          onFulfilment={setFulfilment}
          destination={destination}
          onDestination={setDestination}
          orderNote={orderNote}
          onOrderNote={setOrderNote}
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
      </CheckoutAtTop>
    );
  }

  if (menu.length === 0) {
    return (
      <>
        {header}
        {/* A CLOSED STORE HAS NO MENU, and that is a fact about the store
            rather than an empty catalogue. Saying "nothing here yet" about a
            stall that sells nine things and is shut until four would be a
            different, wrong answer. */}
        <p className="text-muted py-12 text-center">
          {vendor.is_accepting_orders
            ? 'Nothing here yet.'
            : 'Closed right now. Their menu comes back when they open.'}
        </p>
      </>
    );
  }

  return (
    <>
      {header}
      <h2 className="mb-3 text-base font-semibold tracking-tight sm:mb-4 sm:text-lg">{label}</h2>

      {/* Two columns from `md` up. A single long column of short rows wastes
          most of a laptop screen and makes the menu feel thinner than it is. */}
      <ul className="grid gap-3 md:grid-cols-2">
        {menu.map((item) => {
          const chosen = quantities[cardKey(item)] ?? 0;
          // Every line of this item already in the basket, whatever price.
          const variations = items
            .filter((line) => line.menuItemId === item.id && line.unitPricePesewas !== undefined)
            .sort((a, b) => a.unitPricePesewas - b.unitPricePesewas);
          const inBasket = chosen > 0 || variations.length > 0;
          return (
            // AN ANCHOR PER ITEM, so a search result lands on the thing that
            // was searched for, briefly marked so the eye finds it.
            <li
              key={item.id}
              id={`item-${item.id}`}
              className={`rounded-card scroll-mt-24 transition-shadow ${
                found === item.id ? 'ring-brand-600/50 ring-2' : ''
              }`}
            >
              <Card
                className={`flex h-full gap-3.5 p-3.5 transition-colors sm:p-5 ${
                  item.is_available ? '' : 'bg-surface-2/60'
                } ${inBasket ? 'border-brand-600 ring-brand-600/25 ring-1' : ''}`}
              >
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
                      {/* THE AMOUNT IN THE HEADLINE, where a fixed item's price
                          is: what this item will cost, as chosen right now. An
                          amount that is not one of its prices is never shown
                          as the price; the item's range is, until it is. */}
                      {!isVariablePrice(item) ? (
                        <Money pesewas={item.price_pesewas} />
                      ) : checkChosenPrice(item, chosenPrice(item)).ok ? (
                        <Money pesewas={chosenPrice(item)} />
                      ) : (
                        <span className="tabular-nums">{priceSummary(item)}</span>
                      )}
                    </span>
                  </div>

                  {item.description ? (
                    <p className="text-muted mt-1.5 text-sm leading-relaxed">{item.description}</p>
                  ) : null}

                  {item.is_available ? (
                    <>
                      {isVariablePrice(item) ? (
                        <PriceChoice
                          item={item}
                          value={chosenPrice(item)}
                          text={amounts[item.id] ?? cedisText(lowestPrice(item))}
                          onText={(text) =>
                            setAmounts((current) => ({ ...current, [item.id]: text }))
                          }
                        />
                      ) : null}
                      <Stepper
                        value={chosen}
                        onChange={(next) => setQuantity(cardKey(item), next)}
                        label={item.name}
                        disabled={
                          isVariablePrice(item) && !checkChosenPrice(item, chosenPrice(item)).ok
                        }
                      />
                      {/* WHAT IS ALREADY IN THE BASKET at other prices, each
                          one tap from being the line the stepper edits. */}
                      {variations.length > 1 ||
                      (variations.length === 1 &&
                        variations[0].unitPricePesewas !== chosenPrice(item)) ? (
                        <p className="text-muted mt-2.5 flex flex-wrap gap-x-3 gap-y-1 text-sm">
                          <span>In your basket:</span>
                          {variations.map((line) => (
                            <button
                              key={line.key}
                              type="button"
                              onClick={() =>
                                setAmounts((current) => ({
                                  ...current,
                                  [item.id]: cedisText(line.unitPricePesewas),
                                }))
                              }
                              className="text-ink font-semibold tabular-nums underline-offset-2 hover:underline"
                            >
                              <Money pesewas={line.unitPricePesewas} /> × {line.quantity}
                            </button>
                          ))}
                        </p>
                      ) : null}
                    </>
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

/** Checkout opens at the top of the page, not wherever the menu was scrolled to. */
function CheckoutAtTop({ children }) {
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, []);
  return <div>{children}</div>;
}

/**
 * Quantity control.
 *
 * Before anything is chosen it is a single "Add" pill — a −/0/+ stepper sitting
 * at zero on every row is a lot of controls saying nothing. Once there is a
 * quantity it becomes the stepper. Both are 44px targets.
 */
function Stepper({ value, onChange, label, disabled = false }) {
  if (value === 0) {
    return (
      <button
        type="button"
        onClick={() => onChange(1)}
        disabled={disabled}
        className="press border-line-strong hover:border-brand-600 hover:bg-brand-50 mt-3 inline-flex h-10 items-center gap-1.5 rounded-full border px-4 text-sm font-semibold transition-colors disabled:opacity-55"
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
        disabled={disabled}
        className="press bg-brand-700 hover:bg-brand-800 grid size-10 place-items-center rounded-full text-lg font-semibold text-white transition-colors disabled:opacity-55"
      >
        +
      </button>
    </div>
  );
}

/**
 * One screen: what you ordered, how you want it, what it costs, pay.
 *
 * THE CHOICE STARTS EMPTY and Pay stays disabled until it is made; after that,
 * switching is one tap. The total shown is always the server's, and Pay is
 * disabled while a re-quote is in flight, because the figure beside it would be
 * the figure for a choice the customer has just changed.
 */
function Checkout({
  vendor,
  menu,
  items,
  locations,
  deliveryAvailable,
  deliveryFeePesewas,
  packFeePesewas,
  quotedPartnerFee,
  scanOffered,
  mealScan,
  onMealScan,
  scan,
  onScan,
  wantsPack,
  onWantsPack,
  fulfilment,
  onFulfilment,
  destination,
  onDestination,
  orderNote,
  onOrderNote,
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
  // THE SERVER'S UNIT PRICE once there is a quote, so every line agrees with
  // the total beside it even if the store changed the item mid-basket. The
  // quote's lines come back in the order they were sent, and the same item can
  // now be on two of them, so they are matched by position, not by id.
  const quotedLines = quote?.lines?.length === items.length ? quote.lines : null;
  const named = items.map((item, index) => ({
    ...item,
    name: menu.find((m) => m.id === item.menuItemId)?.name ?? 'Item',
    price:
      quotedLines?.[index]?.unit_price_pesewas ??
      item.unitPricePesewas ??
      menu.find((m) => m.id === item.menuItemId)?.price_pesewas ??
      0,
  }));

  // The server's live answer wins over what the page was rendered with: the
  // switch can be flipped while somebody is filling in a basket.
  const canDeliver = quote ? quote.delivery_available !== false : deliveryAvailable;
  const needsChoice = !fulfilment;
  const needsDestination = fulfilment === 'DELIVERY' && !destination;

  // WHAT THE STORE WILL NOT TAKE A MEAL SCAN FOR. Named, so the customer can
  // fix it here rather than at a refused Pay button. price_scan_order() is the
  // enforcement; this is the courtesy.
  const ineligible = mealScan
    ? named
        .filter((item) => menu.find((m) => m.id === item.menuItemId)?.scan_eligible !== true)
        .map((item) => item.name)
    : [];
  const needsScan = mealScan && !scan;
  const scanBlocked = mealScan && ineligible.length > 0;
  // `leaving` keeps the button spent after the action resolves: the browser is
  // on its way to the payment page and a button that springs back to "Pay"
  // invites a second tap at the worst possible moment.
  const leaving = Boolean(submitState.ok);
  const busy = submitting || leaving;
  const hint = needsChoice
    ? 'Choose how you want it.'
    : needsDestination
      ? 'Choose where the Partner should bring it.'
      : needsScan
        ? 'Add a photo of your Meal Scan.'
        : null;

  return (
    <form action={submit} className="mx-auto max-w-xl">
      <input type="hidden" name="vendor_id" value={vendor.vendor_id} />
      {/* Ids and quantities, and a chosen amount only where the customer
          chose one. submit_order() checks that amount against the item's own
          prices and refuses anything else; no other figure leaves the browser. */}
      <input
        type="hidden"
        name="items"
        value={JSON.stringify(
          items.map(({ menuItemId, quantity, unitPricePesewas }) =>
            unitPricePesewas === undefined
              ? { menuItemId, quantity }
              : { menuItemId, quantity, unitPricePesewas }
          )
        )}
      />
      <input type="hidden" name="fulfilment_type" value={fulfilment ?? ''} />
      <input type="hidden" name="destination_location_id" value={destination ?? ''} />
      <input type="hidden" name="order_note" value={orderNote} />
      <input type="hidden" name="destination_note" value={fulfilment === 'DELIVERY' ? note : ''} />
      {/* The path came from our own upload route, built from the session.
          submit_scan_order() re-checks it belongs to this account before
          attaching it, so a tampered field fails in the database. */}
      <input type="hidden" name="scan_image_path" value={mealScan ? (scan?.path ?? '') : ''} />
      <input type="hidden" name="content_type" value={mealScan ? (scan?.contentType ?? '') : ''} />
      <input type="hidden" name="byte_size" value={mealScan ? (scan?.byteSize ?? 0) : 0} />

      <button
        type="button"
        onClick={onBack}
        disabled={busy}
        className="text-muted hover:text-ink hover:bg-surface-2 press-sm mb-4 -ml-2 inline-flex min-h-11 items-center gap-1.5 rounded-full pr-3.5 pl-2 text-sm font-medium transition-colors disabled:opacity-55"
      >
        <ArrowLeftIcon className="size-4" />
        {vendor.name}
      </button>

      <h2 className="text-display text-2xl font-semibold sm:text-3xl">Checkout</h2>

      {/* --- Items ------------------------------------------------------- */}
      <ul className="divide-line border-line mt-6 divide-y border-y">
        {named.map((item) => (
          <li key={item.key} className="flex items-baseline justify-between gap-4 py-3">
            <span className="min-w-0">
              <span className="text-muted mr-2 tabular-nums">{item.quantity}×</span>
              {item.name}
              {item.unitPricePesewas !== undefined ? (
                <span className="text-muted ml-1.5 text-sm">
                  at <Money pesewas={item.price} />
                </span>
              ) : null}
            </span>
            <span className="text-muted shrink-0 text-sm">
              <Money pesewas={item.price * item.quantity} />
            </span>
          </li>
        ))}
      </ul>

      {/* --- Order information -------------------------------------------
          About the food, for the store. It is saved with the order, before
          payment, so the store never opens an order without it. */}
      <NoteField
        label="Order information"
        value={orderNote}
        onChange={onOrderNote}
        placeholder="No pepper, please."
        className="mt-6"
      />

      {/* --- How you want it ---------------------------------------------- */}
      <section className="mt-7">
        <h3 className="mb-3 font-semibold">How you want it</h3>

        <FulfilmentChoice
          value={fulfilment}
          onChange={onFulfilment}
          vendorName={vendor.name}
          partnerAvailable={canDeliver}
          feePesewas={deliveryFeePesewas}
          quotedFee={quotedPartnerFee}
        />

        {fulfilment === 'DELIVERY' && canDeliver ? (
          <div className="mt-5">
            <h4 className="mb-2.5 text-sm font-medium">Where should your Partner bring it?</h4>
            <DestinationPicker places={locations} value={destination} onChange={onDestination} />
            {/* For the Partner only. The store never sees it. */}
            <NoteField
              label="Additional information"
              value={note}
              onChange={onNote}
              placeholder="I'm near the stairs. Call when you arrive."
              className="mt-5"
            />
          </div>
        ) : null}
      </section>

      {/* --- Redeem by Meal Scan ------------------------------------------ */}
      {scanOffered ? (
        <MealScanSection
          on={mealScan}
          onToggle={onMealScan}
          scan={scan}
          onScan={onScan}
          ineligible={ineligible}
          packFeePesewas={packFeePesewas}
          packIsCompulsory={Boolean(quote?.pack_is_compulsory)}
          wantsPack={wantsPack}
          onWantsPack={onWantsPack}
          disabled={busy}
        />
      ) : null}

      {/* --- Money -------------------------------------------------------- */}
      <Card className="mt-7 p-5">
        {quoteError ? (
          <ErrorNote>{quoteError}</ErrorNote>
        ) : quote ? (
          <dl className={`transition-opacity ${quoting ? 'opacity-45' : ''}`}>
            {/* ON A MEAL SCAN THE FOOD IS GH₵0, and the line says why rather
                than disappearing: nobody should leave this page thinking they
                have bought their lunch twice. The service fee is the ordinary
                Campus Dash fee — a Meal Scan adds nothing to it. */}
            <Line
              label="Food"
              hint={mealScan ? 'Covered by your Meal Scan' : null}
              value={mealScan ? 0 : quote.subtotal_pesewas}
            />
            <Line label="Service fee" value={quote.service_fee_pesewas} />
            {quote.pack_fee_pesewas > 0 ? (
              <Line
                label="Pack"
                hint={
                  quote.pack_is_compulsory
                    ? 'Included with a Partner'
                    : 'What your food is carried in'
                }
                value={quote.pack_fee_pesewas}
              />
            ) : null}
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
      </Card>

      {submitState.message ? <ErrorNote className="mt-4">{submitState.message}</ErrorNote> : null}

      <div className="mt-6">
        <button
          type="submit"
          disabled={
            busy || !quote || quoting || needsChoice || needsDestination || needsScan || scanBlocked
          }
          aria-busy={busy || undefined}
          className="press bg-brand-700 hover:bg-brand-800 h-14 w-full rounded-full text-base font-semibold text-white transition-colors disabled:opacity-55"
        >
          {busy ? (
            <span className="inline-flex items-center justify-center gap-2">
              <Spinner className="size-4" />
              Taking you to pay…
            </span>
          ) : quote && !needsChoice ? (
            <>
              Pay <Money pesewas={quote.total_pesewas} />
            </>
          ) : (
            'Pay'
          )}
        </button>
      </div>
      {hint ? <p className="text-muted mt-2.5 text-center text-sm">{hint}</p> : null}

      <ContactLine className="mt-8 text-center" />
    </form>
  );
}

function NoteField({ label, value, onChange, placeholder, className = '' }) {
  return (
    <label className={`block ${className}`}>
      <span className="text-sm font-medium">
        {label} <span className="text-muted font-normal">(optional)</span>
      </span>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        maxLength={NOTE_LIMIT}
        rows={2}
        placeholder={placeholder}
        className="rounded-input bg-surface border-line-strong focus:border-brand-600 placeholder:text-faint mt-2 block w-full resize-none border px-3 py-2.5 text-base outline-none"
      />
    </label>
  );
}

function Line({ label, hint, value }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <dt className="text-muted text-sm">
        {label}
        {hint ? <span className="text-faint block text-xs">{hint}</span> : null}
      </dt>
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
 * sessionStorage as { lineKey: quantity } — a fixed item's key is its id, a
 * variable item's is its id and chosen price (see lib/orders/basket.js). Never
 * a total. On the way back in, a line is dropped if its item is no longer on
 * the menu, or if its price is no longer one of the item's prices: the server
 * would refuse it, exactly as it would an item that has gone.
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
      saved = Object.fromEntries(
        Object.entries(parsed).filter(([line, qty]) => {
          if (!Number.isInteger(qty) || qty < 1 || qty > 50) return false;
          const parts = parseLineKey(line);
          const item = parts && menu.find((m) => m.id === parts.menuItemId && m.is_available);
          if (!item) return false;
          return isVariablePrice(item)
            ? parts.unitPricePesewas !== undefined &&
                checkChosenPrice(item, parts.unitPricePesewas).ok
            : parts.unitPricePesewas === undefined;
        })
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

/* ---------------------------------------------------------------------------
 * A price the customer chooses
 * ------------------------------------------------------------------------ */

/**
 * The amount, as its own control, above the quantity.
 *
 * CHOICES is a row of the store's exact prices, one tap each. STEPPED is one
 * number box: the valid amounts may have no end, so they are typed rather than
 * listed. A typed amount that is not one of the item's prices is NOT corrected
 * — the box keeps what was typed, the nearest prices are named, and nothing
 * can be added until it is one of them.
 *
 * CONTROLLED BY THE PARENT (`text`), because a tap on "In your basket: GH₵20"
 * has to be able to put GH₵20 back in the box.
 */
function PriceChoice({ item, value, text, onText }) {
  if (item.pricing_mode === PRICING_MODE.CHOICES) {
    return (
      <div
        role="radiogroup"
        aria-label={`Price of ${item.name}`}
        className="mt-3 flex flex-wrap gap-2"
      >
        {priceChoices(item).map((pesewas) => {
          const on = pesewas === value;
          return (
            <button
              key={pesewas}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onText(cedisText(pesewas))}
              className={`press-sm h-10 rounded-full border px-4 text-sm font-semibold tabular-nums transition-colors ${
                on
                  ? 'bg-ink border-ink text-white'
                  : 'border-line-strong hover:border-brand-600 hover:bg-brand-50'
              }`}
            >
              <Money pesewas={pesewas} />
            </button>
          );
        })}
      </div>
    );
  }

  return <SteppedAmount item={item} value={value} text={text} onText={onText} />;
}

function SteppedAmount({ item, value, text, onText }) {
  const check = Number.isNaN(value) ? { ok: false } : checkChosenPrice(item, value);
  // Whole cedis on a whole-cedi item: the phone offers digits only.
  const whole =
    Number(item.variable_min_pesewas) % 100 === 0 && Number(item.variable_step_pesewas) % 100 === 0;
  const suggestions = [check.lower, check.higher].filter((p) => Number.isSafeInteger(p));

  return (
    <div className="mt-3">
      <label className="inline-flex items-center gap-2">
        <span className="text-muted text-sm">Amount</span>
        <span
          className={`rounded-input bg-surface focus-within:border-brand-600 inline-flex h-10 items-center border px-3 ${
            check.ok ? 'border-line-strong' : 'border-bad'
          }`}
        >
          <span className="text-muted mr-1 text-sm">GH₵</span>
          <input
            value={text}
            onChange={(event) => onText(event.target.value)}
            inputMode={whole ? 'numeric' : 'decimal'}
            enterKeyHint="done"
            autoComplete="off"
            aria-invalid={!check.ok}
            aria-label={`Amount for ${item.name}, in cedis`}
            className="w-20 bg-transparent text-base font-semibold tabular-nums outline-none"
          />
        </span>
      </label>
      {check.ok ? null : (
        <p className="text-bad mt-1.5 text-sm" role="status">
          {suggestions.length ? (
            <>
              {check.tooHigh ? 'The most an item can cost is GH₵1,000. ' : null}
              Choose{' '}
              {suggestions.map((p, i) => (
                <span key={p}>
                  {i ? ' or ' : ''}
                  <button
                    type="button"
                    onClick={() => onText(cedisText(p))}
                    className="font-semibold underline underline-offset-2"
                  >
                    <Money pesewas={p} />
                  </button>
                </span>
              ))}
              .
            </>
          ) : (
            'Enter an amount.'
          )}
        </p>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Redeem by Meal Scan
 * ------------------------------------------------------------------------ */

/**
 * A Meal Scan is a WAY OF PAYING, offered where the store takes one.
 *
 * OFF BY DEFAULT, and it has to be: most orders are not scan orders, and a
 * switch that starts on would put an upload in front of everybody. Turning it
 * on changes three things and nothing else — the food line goes to zero because
 * the university's entitlement settles it, a photograph of the scan becomes
 * required, and the order arrives on the store's board to be verified before
 * anything is cooked.
 *
 * IT IS NOT A SEPARATE PRODUCT AND MUST NOT LOOK LIKE ONE. No panel, no
 * gradient, no second checkout: one switch in the same column as everything
 * else, and the rest appears underneath it only once it is on.
 */
function MealScanSection({
  on,
  onToggle,
  scan,
  onScan,
  ineligible,
  packFeePesewas,
  packIsCompulsory,
  wantsPack,
  onWantsPack,
  disabled,
}) {
  return (
    <section className="border-line mt-7 border-t pt-6">
      <label className="flex cursor-pointer items-start justify-between gap-4">
        <span className="min-w-0">
          <span className="font-semibold">Redeem by Meal Scan</span>
          <span className="text-muted mt-1 block text-sm leading-relaxed">
            Your campus meal entitlement pays for the food. You pay only the Campus Dash fee.
          </span>
        </span>
        <input
          type="checkbox"
          name="meal_scan"
          checked={on}
          disabled={disabled}
          onChange={(event) => onToggle(event.target.checked)}
          className="accent-brand-700 mt-0.5 size-5 shrink-0"
        />
      </label>

      {on ? (
        <div className="animate-fade-up mt-5 space-y-4">
          {/* WHAT THE STORE WILL NOT HONOUR ONE FOR. Said here rather than at
              the Pay button, because the basket is one tap behind them and
              price_scan_order() would refuse the whole order. */}
          {ineligible.length > 0 ? (
            <ErrorNote>
              {ineligible.length === 1
                ? `${ineligible[0]} cannot be paid for with a Meal Scan.`
                : `${ineligible.join(', ')} cannot be paid for with a Meal Scan.`}{' '}
              Take it out of your basket, or turn the Meal Scan off.
            </ErrorNote>
          ) : null}

          <ScanPhoto scan={scan} onUploaded={onScan} />

          {/* THE PACK. A collection may decline it and bring a container from
              home; a Partner order may not, because there has to be something
              to carry. Whether the choice appears comes from the server's
              pack_is_compulsory, not from reading the fulfilment here. */}
          {packFeePesewas > 0 ? (
            packIsCompulsory ? (
              <p className="text-muted text-sm leading-relaxed">
                A pack is included with a Partner, at <Money pesewas={packFeePesewas} />.
              </p>
            ) : (
              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  name="wants_pack"
                  checked={wantsPack}
                  onChange={(event) => onWantsPack(event.target.checked)}
                  className="accent-brand-700 mt-0.5 size-5 shrink-0"
                />
                <span className="text-sm">
                  <span className="font-medium">
                    Add a pack <Money pesewas={packFeePesewas} />
                  </span>
                  <span className="text-muted mt-0.5 block text-xs leading-relaxed">
                    Leave off if you are bringing your own container.
                  </span>
                </span>
              </label>
            )
          ) : null}

          {/* THE WARNING, AND IT IS THE LAST THING BEFORE THE TOTAL. The store
              checks the scan after the money has moved, and a scan it will not
              accept ends the order without a refund. Somebody about to pay is
              entitled to know that in the sentence before they do. */}
          <Callout tone="warn">
            Make sure your Meal Scan is clear and fully visible. Once your order is paid for,
            payments related to an invalid Meal Scan are non-refundable.
          </Callout>
        </div>
      ) : null}
    </section>
  );
}

/**
 * The photograph, and the two ways to get one.
 *
 * PHOTOS ONLY. "Choose a photo" carries `accept="image/*"`, which is what makes
 * a phone open the camera roll rather than a document browser; "Take a photo"
 * goes to the camera. There is no third route, and PDF is gone — see
 * lib/verification/documents.js for why.
 *
 * THE PREVIEW IS THE POINT. The customer sees the actual image, full width,
 * before they pay, and can replace it as many times as they like — but only
 * until the order exists. After submission the scan is fixed: there is no
 * function that attaches a second one to a paid order, because that would be a
 * second entitlement against one payment.
 */
function ScanPhoto({ scan, onUploaded }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [preview, setPreview] = usePreview();

  async function accept(file) {
    setBusy(true);
    setError(null);
    try {
      const uploaded = await uploadMealScan(file);
      setPreview(URL.createObjectURL(file));
      onUploaded(uploaded);
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p className="text-sm font-medium">
        Your Meal Scan <span className="text-bad">*</span>
      </p>
      <p className="text-muted mt-1 text-xs leading-relaxed">
        A photo. Only you and the store see it, while the order is live.
      </p>

      {preview ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={preview}
          alt="The Meal Scan you are about to send"
          className="border-line rounded-card mt-3 w-full border"
        />
      ) : null}

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <label
          className={`press border-line-strong hover:bg-surface-2 inline-flex h-11 cursor-pointer items-center justify-center rounded-full border text-sm font-semibold transition-colors ${
            busy ? 'pointer-events-none opacity-55' : ''
          }`}
        >
          {scan ? 'Choose another photo' : 'Choose a photo'}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            disabled={busy}
            className="sr-only"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) await accept(file);
            }}
          />
        </label>

        <CameraCapture
          onCaptured={accept}
          disabled={busy}
          label={scan ? 'Retake photo' : 'Take a photo'}
        />
      </div>

      {busy ? (
        <p className="text-muted mt-2 inline-flex items-center gap-2 text-sm">
          <Spinner className="size-3.5" />
          Uploading…
        </p>
      ) : null}
      {error ? <p className="text-bad mt-2 text-sm">{error}</p> : null}
    </div>
  );
}

async function uploadMealScan(file) {
  const form = new FormData();
  form.set('kind', 'scan');
  form.set('file', file, file.name);

  const response = await fetch('/api/verification/documents', { method: 'POST', body: form });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? 'Upload failed.');
  return { path: body.path, contentType: body.contentType, byteSize: body.byteSize };
}

/** Revokes the previous object URL, so retaking does not pin every attempt. */
function usePreview() {
  const [url, setUrl] = useState(null);
  const current = useRef(null);

  useEffect(
    () => () => {
      if (current.current) URL.revokeObjectURL(current.current);
    },
    []
  );

  const set = (next) => {
    if (current.current) URL.revokeObjectURL(current.current);
    current.current = next;
    setUrl(next);
  };

  return [url, set];
}
