'use client';

import { useActionState, useEffect, useRef, useState, useTransition } from 'react';
import CameraCapture from '@/app/camera-capture';
import FulfilmentChoice from '@/app/fulfilment-choice';
import ContactLine from '@/app/contact-line';
import { quoteScanAction, submitScanOrderAction } from '../actions';
import {
  Card,
  Money,
  ErrorNote,
  Skeleton,
  Spinner,
  ArrowLeftIcon,
  Disclosure,
  Container,
} from '@/app/ui';

/**
 * Ordering with a meal scan.
 *
 * ONE THING THIS SCREEN HAS TO GET ACROSS: the scan pays the store for the
 * food, so the food line reads GH₵0.00 and the total is plainly labelled as
 * what Campus Dash charges. Nobody should leave this page thinking they have
 * bought their lunch twice.
 *
 * Otherwise it is the food checkout, and deliberately so — items, how you want
 * it, what you pay, pay — because using a scan is a way of paying rather than a
 * different product. The scan itself is the one extra field.
 */
export default function ScanOrderBuilder({
  header = null,
  vendor,
  menu,
  locations = [],
  partnerAvailable = true,
  partnerFeePesewas = null,
  packFeePesewas = 0,
}) {
  const [quantities, setQuantities] = useState({});
  const [step, setStep] = useState('menu');
  // NOTHING IS PRESELECTED. The customer chooses; the price depends on it.
  const [fulfilment, setFulfilment] = useState(null);
  const [destination, setDestination] = useState('');
  const [note, setNote] = useState('');
  const [details, setDetails] = useState('');
  // THE PACK, on a collection only. Somebody walking to the counter can bring
  // their own container; somebody sending a Partner cannot, so the choice
  // disappears there and the server charges it regardless.
  const [wantsPack, setWantsPack] = useState(false);
  const [scan, setScan] = useState(null);
  const [quote, setQuote] = useState(null);
  // WHICH FULFILMENT THE QUOTE IN HAND WAS PRICED FOR. Switching to a Partner
  // leaves the previous collection quote on screen for one round-trip, and the
  // pack control differs between the two — so the screen needs to know its
  // answer is stale rather than guess at the new one by re-deciding the rule
  // the server owns.
  const [quotedFor, setQuotedFor] = useState(null);
  const [quoteError, setQuoteError] = useState(null);
  const [quoting, startQuoting] = useTransition();
  const [submitState, submit, submitting] = useActionState(submitScanOrderAction, {});

  // THE FEE FOR A PARTNER ORDER, remembered across re-quotes. Only a quote that
  // was actually priced for a Partner may set it, so the option's label is
  // never taken from a collection quote — see FulfilmentChoice.
  const [quotedPartnerFee, setQuotedPartnerFee] = useState(null);

  const items = Object.entries(quantities)
    .filter(([, quantity]) => quantity > 0)
    .map(([menuItemId, quantity]) => ({ menuItemId, quantity }));

  const itemCount = items.reduce((total, item) => total + item.quantity, 0);
  const canOrder = vendor.is_accepting_orders && itemCount > 0;
  const fulfilmentChoice = !partnerAvailable && fulfilment === 'DELIVERY' ? null : fulfilment;

  // Re-price whenever the fulfilment, the destination or the pack choice
  // changes. The service fee is flat and does not move with the basket, but the
  // pack and the Partner fee do, and nothing is added up in the browser either
  // way.
  //
  // THE DESTINATION IS A DEPENDENCY, and leaving it out broke every scan
  // delivery. price_scan_order() REFUSES a Partner order with no destination —
  // rightly, it cannot work out a zone without one — so choosing the Partner
  // before a place raised, and because the destination was not in the list
  // below, picking a place afterwards never re-asked. The checkout stayed on
  // "Something went wrong on our side" with no total and an unpayable button.
  useEffect(() => {
    if (step !== 'review' || items.length === 0) return undefined;

    // NOTHING TO PRICE until somebody has chosen how they want it: the pack and
    // the Partner fee both depend on the answer.
    if (!fulfilmentChoice) return undefined;

    // NOTHING TO ASK YET. A Partner order without a destination is not a
    // pricing failure, it is a question the customer has not answered — the
    // line under the Pay button already asks it. Sending it anyway turned an
    // unfilled field into an internal error. Nothing is cleared here: whatever
    // quote is held was priced for the OTHER fulfilment, and `priced` below
    // already refuses to show one of those.
    if (fulfilmentChoice === 'DELIVERY' && !destination) return undefined;

    let cancelled = false;
    startQuoting(async () => {
      const result = await quoteScanAction({
        vendorId: vendor.vendor_id,
        items,
        fulfilmentType: fulfilmentChoice,
        destinationLocationId: fulfilmentChoice === 'DELIVERY' ? destination || null : null,
        wantsPack,
      });
      if (cancelled) return;
      if (result.ok) {
        setQuote(result.quote);
        setQuotedFor(fulfilmentChoice);
        setQuoteError(null);
        if (fulfilmentChoice === 'DELIVERY') {
          setQuotedPartnerFee(Number(result.quote.delivery_fee_pesewas ?? 0));
        }
      } else {
        setQuote(null);
        setQuotedFor(null);
        setQuoteError(result.message);
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, JSON.stringify(items), fulfilmentChoice, destination, wantsPack, vendor.vendor_id]);

  /**
   * The provider's checkout is on another origin, so getting there is a full
   * browser navigation rather than a client-side route change.
   */
  useEffect(() => {
    if (!submitState.ok) return;
    window.location.href = submitState.redirectUrl || submitState.orderHref;
  }, [submitState]);

  const setQuantity = (id, next) =>
    setQuantities((current) => ({ ...current, [id]: Math.max(0, Math.min(50, next)) }));

  if (menu.length === 0) {
    return (
      <>
        {header}
        <Container size="wide">
          <p className="text-muted py-12 text-center">Nothing here takes a scan right now.</p>
        </Container>
      </>
    );
  }

  if (step === 'review') {
    return (
      <AtTop>
        <ScanCheckout
          vendor={vendor}
          menu={menu}
          items={items}
          locations={locations}
          partnerAvailable={partnerAvailable}
          partnerFeePesewas={partnerFeePesewas}
          quotedPartnerFee={quotedPartnerFee}
          packFeePesewas={packFeePesewas}
          fulfilment={fulfilmentChoice}
          onFulfilment={setFulfilment}
          destination={destination}
          onDestination={setDestination}
          note={note}
          onNote={setNote}
          details={details}
          onDetails={setDetails}
          wantsPack={wantsPack}
          onWantsPack={setWantsPack}
          scan={scan}
          onScan={setScan}
          quote={quote}
          quotedFor={quotedFor}
          quoting={quoting}
          quoteError={quoteError}
          onBack={() => setStep('menu')}
          submit={submit}
          submitting={submitting}
          submitState={submitState}
        />
      </AtTop>
    );
  }

  return (
    <>
      {header}
      <Container size="wide">
        <h2 className="mb-3 text-base font-semibold tracking-tight sm:mb-4 sm:text-lg">
          What your scan covers here
        </h2>

        <ul className="grid gap-3 md:grid-cols-2">
          {menu.map((item) => {
            const chosen = quantities[item.id] ?? 0;
            return (
              <li key={item.id}>
                <Card
                  className={`flex h-full gap-3.5 p-3.5 transition-colors sm:p-5 ${
                    chosen > 0 ? 'border-brand-600 ring-brand-600/25 ring-1' : ''
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-4">
                      <h3 className="font-semibold break-words">{item.name}</h3>
                      {/* THE STORE'S OWN PRICE, struck through, because the scan is
                      what settles it. Showing the value makes it obvious what
                      the entitlement is being spent on; showing it as payable
                      would be a lie. */}
                      <span className="text-muted shrink-0 text-sm line-through">
                        <Money pesewas={item.price_pesewas} />
                      </span>
                    </div>

                    {item.description ? (
                      <p className="text-muted mt-1.5 text-sm leading-relaxed">
                        {item.description}
                      </p>
                    ) : null}

                    <Stepper
                      value={chosen}
                      onChange={(next) => setQuantity(item.id, next)}
                      label={item.name}
                    />
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      </Container>

      {itemCount > 0 ? (
        <div className="animate-sheet fixed inset-x-0 bottom-[calc(57px+env(safe-area-inset-bottom))] z-50 px-3 pb-3 sm:bottom-0 sm:px-6 sm:pb-6">
          <div className="bg-surface border-line shadow-float mx-auto flex max-w-2xl items-center gap-3 rounded-full border p-2 pl-5">
            <span className="flex items-center gap-2 text-sm font-semibold">
              <span className="bg-brand-700 grid size-6 shrink-0 place-items-center rounded-full text-xs text-white tabular-nums">
                {itemCount}
              </span>
              <span>{itemCount === 1 ? 'item' : 'items'}</span>
            </span>
            <button
              type="button"
              disabled={!canOrder}
              onClick={() => setStep('review')}
              className="press bg-brand-700 hover:bg-brand-800 ml-auto rounded-full px-6 py-3 text-sm font-semibold text-white transition-colors disabled:opacity-55"
            >
              Continue
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

/** The checkout opens at the top of the page, with the store header gone. */
function AtTop({ children }) {
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, []);
  return (
    <Container size="wide" className="pt-4 sm:pt-6">
      {children}
    </Container>
  );
}

/** Quantity control. Matches the food menu's exactly. */
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

function ScanCheckout({
  vendor,
  menu,
  items,
  locations,
  partnerAvailable,
  partnerFeePesewas,
  quotedPartnerFee,
  packFeePesewas,
  fulfilment,
  onFulfilment,
  destination,
  onDestination,
  note,
  onNote,
  details,
  onDetails,
  wantsPack,
  onWantsPack,
  scan,
  onScan,
  quote,
  quotedFor,
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

  // A quote priced for the other fulfilment answers a question nobody asked.
  const priced = quote && quotedFor === fulfilment ? quote : null;
  const needsChoice = !fulfilment;
  const needsDestination = fulfilment === 'DELIVERY' && !destination;
  const leaving = Boolean(submitState.ok);
  const busy = submitting || leaving;
  const ready = Boolean(priced && scan && !quoting && !needsChoice && !needsDestination);

  return (
    <form action={submit} className="mx-auto max-w-xl">
      <input type="hidden" name="vendor_id" value={vendor.vendor_id} />
      {/* Ids and quantities only. No prices leave the browser. */}
      <input
        type="hidden"
        name="items"
        value={JSON.stringify(items.map(({ menuItemId, quantity }) => ({ menuItemId, quantity })))}
      />
      <input type="hidden" name="fulfilment_type" value={fulfilment ?? ''} />
      <input type="hidden" name="destination_location_id" value={destination} />
      <input type="hidden" name="destination_note" value={note} />
      <input type="hidden" name="scan_image_path" value={scan?.path ?? ''} />
      <input type="hidden" name="content_type" value={scan?.contentType ?? ''} />
      <input type="hidden" name="byte_size" value={scan?.byteSize ?? 0} />

      <button
        type="button"
        onClick={onBack}
        disabled={busy}
        className="text-muted hover:text-ink hover:bg-surface-2 press-sm mb-4 -ml-2 inline-flex min-h-11 items-center gap-1.5 rounded-full pr-3.5 pl-2 text-sm font-medium transition-colors disabled:opacity-55"
      >
        <ArrowLeftIcon className="size-4" />
        Back to the menu
      </button>

      <h2 className="text-display text-2xl font-semibold sm:text-3xl">Check and pay</h2>
      <p className="text-muted mt-1.5">From {vendor.name}, using your meal scan</p>

      {/* --- Items ------------------------------------------------------- */}
      <Card className="mt-7 p-5">
        <h3 className="mb-3 font-semibold">Your order</h3>
        <ul className="divide-line divide-y">
          {named.map((item) => (
            <li key={item.menuItemId} className="flex items-baseline justify-between gap-4 py-2.5">
              <span className="min-w-0">
                <span className="bg-surface-2 mr-2 inline-block rounded px-1.5 py-0.5 text-xs font-semibold tabular-nums">
                  {item.quantity}×
                </span>
                {item.name}
              </span>
              <span className="text-muted shrink-0 text-sm line-through">
                <Money pesewas={item.price * item.quantity} />
              </span>
            </li>
          ))}
        </ul>
        <p className="text-muted mt-3 text-xs">Your scan covers the food.</p>
      </Card>

      {/* --- The scan ------------------------------------------------------ */}
      <ScanUpload scan={scan} onUploaded={onScan} />

      {/* --- How you want it ---------------------------------------------- */}
      <Card className="mt-4 p-5">
        <h3 className="mb-3 font-semibold">How you want it</h3>

        <FulfilmentChoice
          value={fulfilment}
          onChange={onFulfilment}
          vendorName={vendor.name}
          partnerAvailable={partnerAvailable}
          feePesewas={partnerFeePesewas}
          quotedFee={quotedPartnerFee}
          collectDetail={`Walk to ${vendor.name} and show your scan.`}
        />

        {fulfilment === 'DELIVERY' && partnerAvailable ? (
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

        {/* THE PACK. A collection may decline it and bring a container from
            home; a Partner order may not, because there has to be something to
            carry. The choice is therefore not rendered at all with a Partner
            selected, rather than rendered and disabled — a greyed-out control
            invites somebody to try to un-grey it. The sentence underneath says
            the pack is included, which is the honest version of the same fact.

            Whether it appears comes from the server's pack_is_compulsory, not
            from reading `fulfilment` here, so the rule lives in one place. */}
        {packFeePesewas > 0 && priced ? (
          priced.pack_is_compulsory ? (
            <p className="text-muted mt-4 text-sm leading-relaxed">
              A pack is included with a Partner, at <Money pesewas={priced.pack_fee_pesewas} />.
            </p>
          ) : (
            <label className="border-line mt-4 flex cursor-pointer items-start gap-3 border-t pt-4">
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
      </Card>

      {/* --- Optional context ---------------------------------------------- */}
      {/* OPTIONAL NOW, and that is a consequence of the items being real. This
          used to be the only way anybody knew what to collect, so it had to be
          compulsory. The order says that now. */}
      <Card className="mt-4 px-5">
        <Disclosure title="Add a note for the store" flush defaultOpen={Boolean(details)}>
          <textarea
            name="details"
            maxLength={1000}
            rows={3}
            value={details}
            onChange={(event) => onDetails(event.target.value)}
            placeholder="No pepper. If the chicken is finished, fish is fine."
            aria-label="A note for the store"
            className="rounded-input bg-surface border-line-strong focus:border-brand-600 placeholder:text-faint w-full border px-3 py-2.5 text-base outline-none"
          />
        </Disclosure>
      </Card>

      {/* --- Money -------------------------------------------------------- */}
      <Card className="mt-4 p-5">
        {needsChoice || needsDestination ? (
          // NOT a loading state, and it comes before any error: nothing is in
          // flight and nothing will be until the customer answers, so a
          // skeleton announcing "working out your total" would be waiting on
          // the customer while telling them the opposite.
          <p className="text-muted text-sm leading-relaxed">
            {needsChoice
              ? 'Choose how you want it and the total appears here.'
              : 'Choose where the Partner should bring it and the total appears here.'}
          </p>
        ) : quoteError ? (
          <ErrorNote>{quoteError}</ErrorNote>
        ) : priced ? (
          <dl className={`transition-opacity ${quoting ? 'opacity-45' : ''}`}>
            <div className="flex items-baseline justify-between gap-4 py-1.5">
              <dt className="text-muted text-sm">
                Food
                <span className="text-faint block text-xs">Covered by your meal scan</span>
              </dt>
              <dd className="text-sm font-medium">
                <Money pesewas={0} />
              </dd>
            </div>
            {/* FLAT, and the same figure on every scan order. It is not a share
                of what the scan covered: that is the store's price for food
                Campus Dash did not sell. */}
            <Line label="Service fee" value={priced.service_fee_pesewas} />
            {/* ALWAYS ITS OWN LINE when it is charged. The store packs the meal
                and the fee is the store's; somebody charged for something is
                entitled to see what. It is never folded into another figure. */}
            {priced.pack_fee_pesewas > 0 ? (
              <Line
                label="Pack"
                hint={
                  priced.pack_is_compulsory
                    ? 'Included with a Partner'
                    : 'What your food is carried in'
                }
                value={priced.pack_fee_pesewas}
              />
            ) : null}
            {priced.delivery_fee_pesewas > 0 ? (
              <Line label="Campus Dash Partner" value={priced.delivery_fee_pesewas} />
            ) : null}
            <div className="border-line mt-2 flex items-baseline justify-between gap-4 border-t pt-3">
              <dt className="font-semibold">Total</dt>
              <dd className="text-lg font-semibold">
                <Money pesewas={priced.total_pesewas} />
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
          disabled={busy || !ready}
          aria-busy={busy || undefined}
          className="press bg-brand-700 hover:bg-brand-800 h-14 w-full rounded-full text-base font-semibold text-white transition-colors disabled:opacity-55"
        >
          {busy ? (
            <span className="inline-flex items-center justify-center gap-2">
              <Spinner className="size-4" />
              Taking you to pay…
            </span>
          ) : priced ? (
            <>
              Pay <Money pesewas={priced.total_pesewas} />
            </>
          ) : (
            'Pay'
          )}
        </button>
      </div>
      {!scan ? (
        <p className="text-muted mt-2.5 text-center text-sm">Attach your meal scan to continue.</p>
      ) : needsChoice ? (
        <p className="text-muted mt-2.5 text-center text-sm">Choose how you want it.</p>
      ) : needsDestination ? (
        <p className="text-muted mt-2.5 text-center text-sm">
          Choose where the Partner should bring it.
        </p>
      ) : null}

      <ContactLine className="mt-8 text-center" />
    </form>
  );
}

/**
 * The scan itself, by either route.
 *
 * A photo taken now and a screenshot saved last week are the same evidence, so
 * neither is privileged. What matters is that the image is readable, which is
 * why the preview is full width rather than a thumbnail.
 */
function ScanUpload({ scan, onUploaded }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [preview, setPreview] = usePreview();

  async function accept(file) {
    setBusy(true);
    setError(null);
    try {
      const uploaded = await uploadScan(file);
      setPreview(file.type === 'application/pdf' ? null : URL.createObjectURL(file));
      onUploaded(uploaded);
    } catch (caught) {
      setError(caught.message);
      throw caught;
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mt-4 p-5">
      <h3 className="font-semibold">
        Your meal scan <span className="text-bad">*</span>
      </h3>
      <p className="text-muted mt-1 text-xs leading-relaxed">
        Only you and the store see it, while the order is live.
      </p>

      {preview ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={preview}
          alt="The scan you attached"
          className="border-line rounded-card mt-3 w-full border"
        />
      ) : null}
      {scan && !preview ? <p className="text-muted mt-3 text-sm">PDF attached.</p> : null}

      {/* TWO JOBS, TWO BUTTONS. "Choose" opens the library or files (no
          `capture`, so the library is never taken away). "Take photo" opens the
          camera. See app/camera-capture.js for how each device gets there. */}
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <label
          className={`press border-line-strong hover:bg-surface-2 inline-flex h-11 cursor-pointer items-center justify-center gap-2 rounded-full border text-sm font-semibold transition-colors ${
            busy ? 'pointer-events-none opacity-55' : ''
          }`}
        >
          {scan ? 'Choose another' : 'Choose photo or file'}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp,application/pdf"
            disabled={busy}
            className="sr-only"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (!file) return;
              await accept(file).catch(() => {});
            }}
          />
        </label>

        <CameraCapture
          onCaptured={accept}
          disabled={busy}
          label={scan ? 'Retake photo' : 'Take photo'}
        />
      </div>

      {busy ? (
        <p className="text-muted mt-2 inline-flex items-center gap-2 text-sm">
          <Spinner className="size-3.5" />
          Uploading…
        </p>
      ) : null}
      {error ? <p className="text-bad mt-2 text-sm">{error}</p> : null}
    </Card>
  );
}

async function uploadScan(file) {
  const form = new FormData();
  form.set('kind', 'scan');
  form.set('file', file, file.name);

  const response = await fetch('/api/verification/documents', { method: 'POST', body: form });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? 'Upload failed.');
  return { path: body.path, contentType: body.contentType, byteSize: body.byteSize };
}

/** Revokes the previous object URL, so retrying does not pin every attempt. */
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
