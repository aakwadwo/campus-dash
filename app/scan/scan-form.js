'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { quoteScanAction, submitScanOrderAction } from './actions';

/**
 * Scan delivery, in one screen.
 *
 * THE ONE THING THIS SCREEN HAS TO GET ACROSS: the food is already paid for.
 * Everything about the money panel is built around not letting anyone think
 * they are buying the meal a second time — the scan line reads GH₵0.00 and
 * says why, and the total is labelled as what Campus Dash charges, not what the
 * meal costs.
 *
 * The quote comes from the server every time the restaurant or destination
 * changes. Nothing here computes a price; it only displays one.
 */
export default function ScanForm({ restaurants, locations }) {
  const [scan, setScan] = useState(null); // { path, contentType, byteSize }
  const [vendorId, setVendorId] = useState(restaurants[0]?.id ?? '');
  const [locationId, setLocationId] = useState(locations[0]?.location_id ?? '');
  const [note, setNote] = useState('');

  const [state, submit, submitting] = useActionState(submitScanOrderAction, {});

  // The quote is stored WITH the selection it was priced for. That is what makes
  // "still loading" a derived fact rather than a second piece of state to keep
  // in step — and it means a slow reply for an old selection can never be shown
  // against a new one.
  const key = `${vendorId}|${locationId}`;
  const [priced, setPriced] = useState({ key: null, quote: null, error: null });

  // Re-price whenever the two inputs that affect price change. The scan itself
  // never affects the price: Campus Dash does not know or care what the meal is
  // worth, which is rather the point.
  useEffect(() => {
    let cancelled = false;
    if (!vendorId || !locationId) return undefined;

    quoteScanAction({ vendorId, destinationLocationId: locationId }).then((result) => {
      if (cancelled) return;
      setPriced(
        result.ok
          ? { key, quote: result.quote, error: null }
          : { key, quote: null, error: result.message }
      );
    });

    return () => {
      cancelled = true;
    };
  }, [vendorId, locationId, key]);

  const fresh = priced.key === key;
  const quote = fresh ? priced.quote : null;
  const quoteError = fresh ? priced.error : null;
  const quoting = !fresh;

  const ready = Boolean(scan && vendorId && locationId && quote);

  return (
    <form action={submit} className="mt-6 space-y-5">
      <input type="hidden" name="vendor_id" value={vendorId} />
      <input type="hidden" name="destination_location_id" value={locationId} />
      <input type="hidden" name="scan_image_path" value={scan?.path ?? ''} />
      <input type="hidden" name="content_type" value={scan?.contentType ?? ''} />
      <input type="hidden" name="byte_size" value={scan?.byteSize ?? 0} />

      <ScanUpload scan={scan} onUploaded={setScan} />

      <section className="rounded-card bg-surface ring-line p-4 ring-1">
        <label className="block">
          <span className="text-sm font-medium">Which restaurant?</span>
          <select
            value={vendorId}
            onChange={(event) => setVendorId(event.target.value)}
            className="rounded-input border-line-strong bg-surface mt-2 w-full border px-3 py-2.5 text-sm transition-colors"
          >
            {restaurants.map((r) => (
              <option key={r.id} value={r.id} disabled={!r.is_accepting_orders}>
                {r.name}
                {r.is_accepting_orders ? '' : ' (closed)'}
              </option>
            ))}
          </select>
        </label>

        <label className="mt-4 block">
          <span className="text-sm font-medium">Where should it be brought?</span>
          <select
            value={locationId}
            onChange={(event) => setLocationId(event.target.value)}
            className="rounded-input border-line-strong bg-surface mt-2 w-full border px-3 py-2.5 text-sm transition-colors"
          >
            {locations.map((l) => (
              <option key={l.location_id} value={l.location_id}>
                {l.path}
              </option>
            ))}
          </select>
        </label>

        <label className="mt-4 block">
          <span className="text-sm font-medium">Anything else? (optional)</span>
          <input
            name="destination_note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Call when you reach the gate"
            className="rounded-input border-line-strong bg-surface mt-2 w-full border px-3 py-2.5 text-sm transition-colors"
          />
        </label>
      </section>

      <MoneyPanel quote={quote} quoting={quoting} error={quoteError} />

      {state?.message && !state.ok ? (
        <p className="rounded-card bg-bad-bg text-bad px-4 py-3 text-sm">{state.message}</p>
      ) : null}

      <button
        type="submit"
        disabled={!ready || submitting}
        className="press bg-brand-500 text-ink w-full rounded-full py-3.5 text-base font-semibold transition-colors disabled:opacity-55"
      >
        {submitting ? 'Creating…' : 'Continue to payment'}
      </button>
      <p className="text-muted text-center text-xs">
        You pay on the next screen. We look for a Partner once the fee is paid.
      </p>
    </form>
  );
}

/**
 * The money. Read this panel as the product's promise: the meal is GH₵0 here,
 * and the number at the bottom is the errand.
 */
function MoneyPanel({ quote, quoting, error }) {
  if (error) {
    return (
      <section className="rounded-card bg-warn-bg text-warn p-4 text-sm">
        <p className="font-semibold">Scan delivery is unavailable right now.</p>
        <p className="mt-1">{error}</p>
      </section>
    );
  }

  return (
    <section className="rounded-card bg-surface ring-line p-4 ring-1">
      <h2 className="text-muted text-xs font-medium tracking-wide uppercase">What you pay</h2>

      <dl className="mt-3 space-y-2 text-sm">
        <div className="flex items-baseline justify-between gap-4">
          <dt>
            Scan
            <span className="text-muted block text-xs">Already paid through the meal system</span>
          </dt>
          <dd className="font-medium">GH₵0.00</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted">Delivery fee</dt>
          <dd>{quote ? cedis(quote.delivery_fee_pesewas) : '-'}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted">Service fee</dt>
          <dd>{quote ? cedis(quote.service_fee_pesewas) : '-'}</dd>
        </div>
        <div className="border-line flex justify-between gap-4 border-t pt-2 font-semibold">
          <dt>You pay</dt>
          <dd>{quoting ? '…' : quote ? cedis(quote.total_pesewas) : '-'}</dd>
        </div>
      </dl>

      <p className="text-muted mt-3 text-xs leading-relaxed">
        You have already paid for the food through the campus meal system. Campus Dash charges you
        only for bringing it to you.
      </p>
    </section>
  );
}

function ScanUpload({ scan, onUploaded }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [preview, setPreview] = usePreview();

  return (
    <section className="rounded-card bg-surface ring-line p-4 ring-1">
      <h2 className="text-sm font-medium">
        Your scan <span className="text-bad">*</span>
      </h2>
      <p className="text-muted mt-1 text-xs leading-relaxed">
        A photo, screenshot or PDF of the scan you want redeemed. It is stored privately. Only you
        can see it until a Partner takes the job, and then only that Partner.
      </p>

      <input
        type="file"
        accept="image/jpeg,image/png,image/webp,application/pdf"
        disabled={busy}
        onChange={async (event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          setBusy(true);
          setError(null);
          try {
            const uploaded = await uploadScan(file);
            setPreview(file.type === 'application/pdf' ? null : URL.createObjectURL(file));
            onUploaded(uploaded);
          } catch (caught) {
            setError(caught.message);
          } finally {
            setBusy(false);
          }
        }}
        className="mt-3 w-full text-sm"
      />

      {busy ? <p className="text-muted mt-2 text-sm">Uploading…</p> : null}
      {preview ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={preview}
          alt="The scan you selected"
          className="ring-line mt-3 w-full rounded ring-1"
        />
      ) : null}
      {scan && !preview ? <p className="text-muted mt-2 text-sm">PDF received.</p> : null}
      {scan ? (
        <p className="text-brand-700 mt-2 text-sm font-medium">
          ✓ Scan received. Check it is readable, and choose another file above if not.
        </p>
      ) : null}
      {error ? <p className="text-bad mt-2 text-sm">{error}</p> : null}
    </section>
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

function cedis(pesewas) {
  return `GH₵${(Number(pesewas ?? 0) / 100).toFixed(2)}`;
}
