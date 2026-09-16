'use client';

import { Money } from './ui';

/**
 * How you want it: collect it yourself, or a Campus Dash Partner.
 *
 * Shared by the food checkout and the meal-scan checkout so the two cannot
 * drift, and so the bug below is fixed in one place rather than two.
 *
 * THE PARTNER PRICE IS THE OPTION'S OWN PRICE, NEVER THE CURRENT QUOTE'S.
 *
 * This is the whole reason the component exists. The checkout re-prices when
 * the choice changes, and for a moment after the tap the page is holding the
 * PREVIOUS quote — the one for collection, whose Partner fee is legitimately
 * zero. Reading the fee off `quote.delivery_fee_pesewas` therefore rendered
 * "Free" against the Campus Dash Partner option for one round trip, every
 * single time somebody chose it, before snapping to GH₵5.
 *
 * So the price shown here comes from `feePesewas`, which the server rendered
 * with the page from pricing_config, and a quote may only OVERRIDE it when that
 * quote was actually priced for a Partner order — which is what `quotedFee`
 * means and why the caller passes null rather than a zero. There is no state in
 * which this can show "Free" for a Partner: the figure is correct on first
 * paint, correct during the re-quote, and correct after it.
 *
 * The fee is never hidden while it loads either. A number that is right and
 * settled reads as a price; a number that appears late reads as a surcharge.
 */
export default function FulfilmentChoice({
  value,
  onChange,
  vendorName,
  partnerAvailable = true,
  feePesewas = null,
  quotedFee = null,
  collectLabel = 'Collect it yourself',
  collectDetail = null,
}) {
  const partnerFee = quotedFee ?? feePesewas;

  return (
    <div className="grid gap-2.5 sm:grid-cols-2">
      <Choice
        selected={value === 'PICKUP'}
        onSelect={() => onChange('PICKUP')}
        title={collectLabel}
        detail={collectDetail ?? `Walk to ${vendorName} and pick it up.`}
        price={0}
      />
      <Choice
        selected={value === 'DELIVERY'}
        onSelect={() => onChange('DELIVERY')}
        disabled={!partnerAvailable}
        title="Campus Dash Partner"
        detail={
          partnerAvailable
            ? 'Another student brings it to you.'
            : 'No Partners are available right now.'
        }
        price={partnerFee}
      />
    </div>
  );
}

/** One option. A whole-card target, because a radio dot is 12px. */
function Choice({ selected, onSelect, title, detail, price, disabled = false }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      aria-pressed={selected}
      className={`rounded-card press w-full border p-3.5 text-left transition-colors ${
        disabled
          ? 'border-line bg-surface-2/60 cursor-not-allowed'
          : selected
            ? 'border-brand-600 bg-brand-50 ring-brand-600/25 ring-1'
            : 'border-line-strong hover:bg-surface-2'
      }`}
    >
      <span className="flex items-baseline justify-between gap-2">
        <span className={`font-semibold ${disabled ? 'text-muted' : ''}`}>{title}</span>
        {!disabled && price !== null ? (
          <span className="shrink-0 text-sm font-semibold">
            {/* "No fee" rather than "Free", which is a word about the food. */}
            {price > 0 ? <Money pesewas={price} /> : 'No fee'}
          </span>
        ) : null}
      </span>
      <span className="text-muted mt-1 block text-xs leading-relaxed">{detail}</span>
    </button>
  );
}
